import { PCM_SAMPLE_RATE } from '@shared/protocol';

type Listener = () => void;

/**
 * One AudioContext for the whole page. Plays streamed PCM gaplessly and archived
 * WAVs, and exposes a live level so the UI can breathe with her voice.
 */
class AudioEngine {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelData: Uint8Array<ArrayBuffer> | null = null;
  private streams = new Map<string, { cursor: number; sources: AudioBufferSourceNode[] }>();
  /** Streams the listener stopped mid-way; ids are random, so this never needs pruning in practice. */
  private muted = new Set<string>();
  private clip: { id: string; source: AudioBufferSourceNode; startedAt: number; duration: number } | null = null;
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
    if (ctx.state === 'suspended') void ctx.resume();
  }

  get unlocked() { return this.ctx?.state === 'running'; }

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
    if (!this.analyser || !this.levelData || !this.playing) return 0;
    this.analyser.getByteTimeDomainData(this.levelData);
    let sum = 0;
    for (const value of this.levelData) { const v = (value - 128) / 128; sum += v * v; }
    return Math.min(1, Math.sqrt(sum / this.levelData.length) * 4);
  }

  /** Queues one streamed PCM chunk right after the previous one. */
  pushPcm(audioId: string, base64: string) {
    const ctx = this.context();
    if (ctx.state !== 'running') return; // Not unlocked: the archived WAV can be replayed later.
    if (this.muted.has(audioId)) return; // The listener stopped this one; later chunks stay silent.
    if (this.clip) this.stopClip();
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const samples = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
    const buffer = ctx.createBuffer(1, samples.length, PCM_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i]! / 32768;

    const stream = this.streams.get(audioId) ?? { cursor: 0, sources: [] };
    // A small lead absorbs network jitter between chunks.
    const start = Math.max(stream.cursor, ctx.currentTime + 0.08);
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

  isStreaming(audioId: string) { return Boolean(this.streams.get(audioId)?.sources.length); }

  async playClip(id: string, url: string) {
    const ctx = this.context();
    if (ctx.state === 'suspended') await ctx.resume();
    this.stopAll();
    const response = await fetch(url);
    if (!response.ok) throw new Error(`audio ${response.status}`);
    const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser!);
    source.start();
    this.clip = { id, source, startedAt: ctx.currentTime, duration: buffer.duration };
    source.onended = () => {
      if (this.clip?.source === source) { this.clip = null; this.setPlaying(null); }
    };
    this.setPlaying(id);
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
