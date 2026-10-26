import { PCM_SAMPLE_RATE } from '@shared/protocol';

type Listener = () => void;

/** The switcher's three sounds: noise band and sine in Hz, level, and length. */
const CLICKS = {
  tick: { band: 4200, tone: 2800, gain: 0.15, seconds: 0.018 },
  settle: { band: 3200, tone: 2300, gain: 0.18, seconds: 0.026 },
  thud: { band: 900, tone: 2000, gain: 0.12, seconds: 0.028 },
} as const;

/**
 * One AudioContext for the whole page. Plays streamed PCM gaplessly and archived
 * WAVs, and exposes a live level so the UI can breathe with her voice.
 */
class AudioEngine {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelData: Uint8Array<ArrayBuffer> | null = null;
  /** `origin` is the context time the stream's first chunk was scheduled at. */
  private streams = new Map<string, { cursor: number; origin: number | null; sources: AudioBufferSourceNode[] }>();
  /** Streams the listener stopped mid-way; ids are random, so this never needs pruning in practice. */
  private muted = new Set<string>();
  private clip: { id: string; source: AudioBufferSourceNode; startedAt: number; duration: number } | null = null;
  /**
   * What she said lately, kept as it arrived, so saying it again plays it back
   * rather than synthesizing it twice. Only the last few: a replay is of her
   * latest turn, and older ones still have their archive.
   */
  private takes = new Map<string, { chunks: Float32Array<ArrayBuffer>[]; buffer: AudioBuffer | null }>();
  /** Fixed lines decoded while the page loads, so the first can play the moment a click allows it. */
  private prepared = new Map<string, Promise<AudioBuffer | null>>();
  /** Held by the listener: the whole clock stops, captions included, until resumed. */
  paused = false;
  private listeners = new Set<Listener>();
  /** Id of whatever is audible right now: a stream's audioId or a replayed clip. */
  playing: string | null = null;

  private context() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: PCM_SAMPLE_RATE });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.6;
      this.analyser.connect(this.ctx.destination);
      this.levelData = new Uint8Array(this.analyser.fftSize);
    }
    return this.ctx;
  }

  /** Browsers block audio until a user gesture; call from any click/keypress. */
  unlock() {
    const ctx = this.context();
    // Any click unlocks — but a click is not how a pause is let go of.
    if (ctx.state === 'suspended' && !this.paused) void ctx.resume();
  }

  get unlocked() { return this.ctx?.state === 'running'; }

  /**
   * Fetches and decodes a clip without playing it. A context can decode
   * before any gesture, it just cannot be heard yet. Resolves false on a
   * failure, which leaves playClip to fetch it again.
   */
  prepare(id: string, url: string): Promise<boolean> {
    let decoded = this.prepared.get(id);
    if (!decoded) {
      decoded = fetch(url)
        .then(response => response.ok ? response.arrayBuffer() : Promise.reject(new Error(`audio ${response.status}`)))
        .then(bytes => this.context().decodeAudioData(bytes))
        .catch(() => null);
      this.prepared.set(id, decoded);
    }
    return decoded.then(Boolean);
  }

  /** Stands the context and the interface bus up ahead, so the first switcher tick is not the one that pays for it. */
  warm() { this.effects(this.context()); }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify() { for (const listener of this.listeners) listener(); }

  private setPlaying(id: string | null) {
    if (this.playing === id) return;
    this.playing = id;
    this.notify();
  }

  /** 0..1 RMS loudness of what is playing now. */
  level(): number {
    // Paused, the analyser still holds its last frame: that is not her voice going on.
    if (!this.analyser || !this.levelData || !this.playing || this.paused) return 0;
    this.analyser.getByteTimeDomainData(this.levelData);
    let sum = 0;
    for (const value of this.levelData) { const v = (value - 128) / 128; sum += v * v; }
    return Math.min(1, Math.sqrt(sum / this.levelData.length) * 4);
  }

  /** Queues one streamed PCM chunk right after the previous one. */
  pushPcm(audioId: string, base64: string) {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const samples = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
    const channel = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i]! / 32768;
    // Kept even when it is not heard: locked or stopped, it can still be played again.
    this.keep(audioId, channel);

    const ctx = this.context();
    if (ctx.state !== 'running' && !this.paused) return; // Not unlocked: the archived WAV can be replayed later.
    if (this.muted.has(audioId)) return; // The listener stopped this one; later chunks stay silent.
    if (this.clip) this.stopClip();
    const buffer = ctx.createBuffer(1, channel.length, PCM_SAMPLE_RATE);
    buffer.copyToChannel(channel, 0);

    const stream = this.streams.get(audioId) ?? { cursor: 0, origin: null, sources: [] };
    // A small lead absorbs network jitter between chunks.
    const start = Math.max(stream.cursor, ctx.currentTime + 0.08);
    stream.origin ??= start;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser!);
    source.start(start);
    stream.cursor = start + buffer.duration;
    stream.sources.push(source);
    source.onended = () => {
      stream.sources = stream.sources.filter(s => s !== source);
      if (!stream.sources.length && this.playing === audioId) this.setPlaying(null);
    };
    this.streams.set(audioId, stream);
    this.setPlaying(audioId);
  }

  private keep(audioId: string, channel: Float32Array<ArrayBuffer>) {
    const take = this.takes.get(audioId);
    if (take) { take.chunks.push(channel); take.buffer = null; return; }
    this.takes.set(audioId, { chunks: [channel], buffer: null });
    // Maps keep insertion order: the first key is the oldest take.
    if (this.takes.size > 3) this.takes.delete(this.takes.keys().next().value!);
  }

  /** A kept take as one buffer, joined once and remembered. */
  private kept(ctx: AudioContext, id: string): AudioBuffer | null {
    const take = this.takes.get(id);
    if (!take) return null;
    if (!take.buffer) {
      const length = take.chunks.reduce((sum, c) => sum + c.length, 0);
      const buffer = ctx.createBuffer(1, length, PCM_SAMPLE_RATE);
      let offset = 0;
      for (const chunk of take.chunks) { buffer.copyToChannel(chunk, 0, offset); offset += chunk.length; }
      take.buffer = buffer;
    }
    return take.buffer;
  }

  isStreaming(audioId: string) { return Boolean(this.streams.get(audioId)?.sources.length); }

  /**
   * Seconds of `audioId` that have been heard, for lining captions up with it.
   * Negative while a stream waits out its jitter lead. Null when it is not
   * playing (never started, or stopped and forgotten).
   */
  heardTime(audioId: string): number | null {
    if (!this.ctx) return null;
    if (this.clip?.id === audioId) return this.ctx.currentTime - this.clip.startedAt;
    const stream = this.streams.get(audioId);
    if (!stream?.origin) return null;
    return this.ctx.currentTime - stream.origin;
  }

  /**
   * Plays something she already said: from memory if it was heard here,
   * otherwise from its archive. `ended` settles when it finishes or is stopped.
   */
  async playClip(id: string, url: string): Promise<{ ended: Promise<void> }> {
    const ctx = this.context();
    this.paused = false;
    // Without a user gesture resume() never settles; give up instead of waiting forever.
    if (ctx.state === 'suspended') await Promise.race([ctx.resume(), new Promise(resolve => setTimeout(resolve, 400))]);
    if (ctx.state !== 'running') throw new Error('audio locked');
    this.stopAll();
    let buffer = this.kept(ctx, id) ?? await this.prepared.get(id) ?? null;
    if (!buffer) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`audio ${response.status}`);
      buffer = await ctx.decodeAudioData(await response.arrayBuffer());
      this.takes.set(id, { chunks: [], buffer });
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser!);
    const ended = new Promise<void>(resolve => {
      source.onended = () => {
        if (this.clip?.source === source) { this.clip = null; this.setPlaying(null); }
        resolve();
      };
    });
    source.start();
    this.clip = { id, source, startedAt: ctx.currentTime, duration: buffer.duration };
    this.setPlaying(id);
    return { ended };
  }

  /**
   * Holds her mid-sentence, or lets her go on. The context itself is
   * suspended, so the voice, its schedule and the clock the captions read
   * all stop together and pick up exactly where they were.
   */
  togglePause() {
    const ctx = this.ctx;
    if (!ctx || !this.playing) return;
    this.paused = !this.paused;
    void (this.paused ? ctx.suspend() : ctx.resume());
    this.notify();
  }

  /**
   * One soft intake of breath while she thinks, so the silence before a reply
   * reads as her gathering herself rather than the app stalling. Synthesized
   * noise, below the analyser and outside `playing`, so nothing on screen
   * mistakes it for her voice.
   */
  breath() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this.playing) return;
    const seconds = 0.7;
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < channel.length; i++) channel[i] = Math.random() * 2 - 1;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    // Breath is air, not hiss: a low band, swept up a little as the lungs fill.
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 0.8;
    band.frequency.setValueAtTime(700, ctx.currentTime);
    band.frequency.linearRampToValueAtTime(1100, ctx.currentTime + seconds);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.035, ctx.currentTime + seconds * 0.45);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + seconds);
    source.connect(band).connect(gain).connect(ctx.destination);
    source.start();
  }

  /**
   * The switcher's mechanics: a tick per card passed, a settle as one comes
   * to rest, a thud at either end. Each is a breath of filtered noise and a
   * short high sine, under 30 ms — felt more than heard. `speed` (0..1)
   * lifts a fast flick up to three semitones and takes a little off it, so
   * a run of ticks reads as speed, not as louder.
   */
  click(kind: 'tick' | 'settle' | 'thud', speed = 0) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    // Closer than 40 ms they blur into a buzz; dropping one is not missed.
    if (kind === 'tick' && now - this.lastTick < 0.04) return;
    if (kind === 'tick') this.lastTick = now;
    const voice = CLICKS[kind];
    const fast = Math.max(0, Math.min(1, speed));
    const semitones = fast * 3 + (Math.random() * 2 - 1);
    const pitch = 2 ** (semitones / 12);
    const level = voice.gain * (1 - fast * 0.25);
    const end = now + voice.seconds;

    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * voice.seconds), ctx.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < channel.length; i++) channel[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 1.4;
    band.frequency.value = voice.band * pitch;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(level, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, end);
    noise.connect(band).connect(noiseGain).connect(this.effects(ctx));

    const sine = ctx.createOscillator();
    sine.frequency.value = voice.tone * pitch;
    const sineGain = ctx.createGain();
    sineGain.gain.setValueAtTime(level * 0.5, now);
    sineGain.gain.exponentialRampToValueAtTime(0.0001, now + voice.seconds * 0.7);
    sine.connect(sineGain).connect(this.effects(ctx));

    noise.start(now);
    noise.stop(end);
    sine.start(now);
    sine.stop(end);
  }

  private lastTick = 0;
  private effectsGain: GainNode | null = null;

  /** One bus for every interface sound, beside her voice and outside the analyser. */
  private effects(ctx: AudioContext) {
    if (!this.effectsGain) {
      this.effectsGain = ctx.createGain();
      this.effectsGain.connect(ctx.destination);
    }
    return this.effectsGain;
  }

  /** 0..1 progress of the replayed clip, or null. */
  clipProgress(id: string): number | null {
    if (!this.clip || this.clip.id !== id || !this.ctx) return null;
    return Math.min(1, (this.ctx.currentTime - this.clip.startedAt) / this.clip.duration);
  }

  private stopClip() {
    const clip = this.clip;
    this.clip = null;
    clip?.source.stop();
  }

  stopAll() {
    if (this.paused) { this.paused = false; void this.ctx?.resume(); }
    this.stopClip();
    for (const [id, stream] of this.streams) {
      for (const source of stream.sources) source.stop();
      this.muted.add(id);
    }
    this.streams.clear();
    this.setPlaying(null);
  }
}

export const audio = new AudioEngine();
