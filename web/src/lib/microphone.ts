/**
 * The microphone, for one spoken answer at a time. Records until the speaker
 * has said something and then gone quiet, or a hard cap, and exposes a live
 * level so her coil can move with the user's voice.
 *
 * Nothing here decides what was said: the clip goes to the server whole.
 */

/** Below this RMS (0..1) counts as silence. Room noise sits well under it; speech well over. */
const SPEECH_LEVEL = 0.035;
/** Quiet this long after some speech ends the answer. */
const TRAILING_SILENCE_MS = 1100;
/** Nothing said at all for this long: give up and let the page offer typing. */
const NO_SPEECH_MS = 7000;
/** Hard cap on one answer; a name takes a few seconds. */
const MAX_MS = 8000;

export type MicFailure = 'unsupported' | 'denied' | 'no-device' | 'failed';
export type Heard = { audio: Blob; mime: string } | { silent: true };

class MicFailureError extends Error {
  constructor(public reason: MicFailure) { super(reason); }
}

const recorderMime = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
  .find(type => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) ?? '';

class Microphone {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private data: Float32Array<ArrayBuffer> | null = null;
  private current = 0;
  /** Set while an answer is recording, so a tap or a released key can end it. */
  private finish: (() => void) | null = null;

  /** 0..1 loudness of the user right now; 0 when not listening. */
  level() {
    if (!this.analyser || !this.data) return 0;
    this.analyser.getFloatTimeDomainData(this.data);
    let sum = 0;
    for (const v of this.data) sum += v * v;
    this.current = Math.sqrt(sum / this.data.length);
    return Math.min(1, this.current * 6);
  }

  get supported() {
    return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined';
  }

  /** Opens the microphone, which is when the system asks for permission. */
  async open(): Promise<void> {
    if (this.stream) return;
    if (!this.supported) throw new MicFailureError('unsupported');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (error) {
      const name = (error as DOMException).name;
      throw new MicFailureError(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied'
        : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'no-device' : 'failed');
    }
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.data = new Float32Array(this.analyser.fftSize);
    this.ctx.createMediaStreamSource(this.stream).connect(this.analyser);
  }

  /** Ends the answer in progress, keeping what was said. Ignored when nothing is recording. */
  stop() {
    this.finish?.();
  }

  /**
   * Records one answer: starts at once; ends when `stop()` is called (a second
   * tap, a released key), on trailing silence after speech, on the cap, or when
   * `signal` aborts. Resolves `{ silent: true }` when nothing was said or the
   * answer was aborted.
   */
  async listen({ signal }: { signal?: AbortSignal } = {}): Promise<Heard> {
    await this.open();
    const stream = this.stream!;
    if (this.ctx?.state === 'suspended') await this.ctx.resume();
    const mime = recorderMime();
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };

    const started = performance.now();
    let spoke = false;
    let quietSince: number | null = null;

    const ended = new Promise<void>(resolve => { recorder.onstop = () => resolve(); });
    recorder.start(250);
    await new Promise<void>(resolve => {
      const finish = () => { clearInterval(timer); signal?.removeEventListener('abort', finish); this.finish = null; resolve(); };
      this.finish = finish;
      signal?.addEventListener('abort', finish, { once: true });
      const timer = window.setInterval(() => {
        const now = performance.now();
        this.level();
        const loud = this.current > SPEECH_LEVEL;
        if (loud) { spoke = true; quietSince = null; }
        else if (spoke) quietSince ??= now;
        const elapsed = now - started;
        if (elapsed > MAX_MS || (!spoke && elapsed > NO_SPEECH_MS) || (quietSince !== null && now - quietSince > TRAILING_SILENCE_MS)) finish();
      }, 50);
    });
    if (recorder.state !== 'inactive') recorder.stop();
    await ended;
    if (!spoke || signal?.aborted) return { silent: true };
    const type = recorder.mimeType || mime || 'audio/webm';
    return { audio: new Blob(chunks, { type }), mime: type.split(';')[0]! };
  }

  /** Lets go of the microphone so the system indicator turns off. */
  close() {
    this.finish?.();
    this.stream?.getTracks().forEach(track => track.stop());
    this.ctx?.close().catch(() => { });
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
    this.data = null;
    this.current = 0;
  }
}

export const microphone = new Microphone();
export { MicFailureError };
