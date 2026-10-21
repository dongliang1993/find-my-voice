import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { DomainError } from './errors.js';

export type PlaybackReport = {
  state: 'starting' | 'playing' | 'completed' | 'stopped' | 'failed';
  format: 'pcm_s16le'; sample_rate: 24000; channels: 1;
  chunks: number; pcm_bytes: number; engine_ready_ms?: number;
  first_chunk_ms?: number; first_render_ms?: number; synthesis_completed_ms?: number;
  playback_completed_ms?: number; rendered_before_synthesis_completed?: boolean;
  non_silent_output_frames?: number; peak?: number; error?: string;
};
export interface StreamingPlayback {
  readonly audioId: string; readonly controller: AbortController; readonly report: PlaybackReport; readonly active: boolean;
  write(chunk: Buffer): Promise<void>; finish(): void; stop(reason?: string): void; wait(): Promise<PlaybackReport>;
}

export function readPlaybackReport(config: Config, id: string): PlaybackReport | undefined {
  const path = resolve(config.dataDir, 'playback', `${id}.json`);
  if (!existsSync(path)) return;
  try { return JSON.parse(readFileSync(path, 'utf8')) as PlaybackReport; } catch { return; }
}

export class PcmPlayback {
  readonly controller = new AbortController();
  readonly report: PlaybackReport = { state: 'starting', format: 'pcm_s16le', sample_rate: 24000, channels: 1, chunks: 0, pcm_bytes: 0 };
  private child!: ChildProcessWithoutNullStreams;
  private token = randomUUID();
  private path: string;
  private lockPath: string;
  private done!: Promise<void>;
  private closed = false;
  private ended = false;

  private constructor(private config: Config, readonly audioId: string, private startedAt: number) {
    this.path = resolve(config.dataDir, 'playback', `${audioId}.json`);
    this.lockPath = resolve(config.dataDir, 'playback.lock');
  }
  static async start(config: Config, audioId: string, startedAt = performance.now()) {
    if (process.platform !== 'darwin' || !existsSync(resolve(config.root, 'dist/pcm-player'))) {
      throw new DomainError('LOCAL_PLAYBACK_UNAVAILABLE', '本机流式播放需要 macOS 和已构建的 PCM 播放器，请先运行 npm run build。');
    }
    const session = new PcmPlayback(config, audioId, startedAt);
    session.acquireLock();
    try { await session.launch(); return session; }
    catch (error) { session.releaseLock(); throw error; }
  }
  private acquireLock() {
    mkdirSync(resolve(this.config.dataDir, 'playback'), { recursive: true, mode: 0o700 });
    if (existsSync(this.lockPath)) {
      let alive = true;
      try {
        const lock = JSON.parse(readFileSync(this.lockPath, 'utf8'));
        if (!Number.isInteger(lock.pid) || lock.pid < 1) throw new Error('invalid lock');
        try { process.kill(lock.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
      } catch { /* An unreadable lock is not safe to take over. */ }
      if (alive) throw new DomainError('LOCAL_PLAYBACK_BUSY', '本地已有语音正在播放，请等待结束或停止后再生成。', 409);
      unlinkSync(this.lockPath);
    }
    try { writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, token: this.token, audio_id: this.audioId }), { flag: 'wx', mode: 0o600 }); }
    catch { throw new DomainError('LOCAL_PLAYBACK_BUSY', '本地播放通道已被占用，未提交新的 TTS 请求。', 409); }
  }
  private releaseLock() {
    try {
      if (JSON.parse(readFileSync(this.lockPath, 'utf8')).token === this.token) unlinkSync(this.lockPath);
    } catch { /* Another session's lock must never be removed. */ }
  }
  private elapsed() { return Math.round(performance.now() - this.startedAt); }
  private save() {
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(this.report, null, 2), { mode: 0o600 });
    renameSync(temp, this.path);
  }
  private async launch() {
    this.child = spawn(resolve(this.config.root, 'dist/pcm-player'), [], { stdio: ['pipe', 'pipe', 'pipe'] });
    // Native diagnostics are not forwarded to the MCP stdio protocol.
    this.child.stderr.resume();
    this.child.stdin.on('error', () => {});
    let readyResolve!: () => void, readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const timer = setTimeout(() => {
      readyReject(new DomainError('LOCAL_PLAYBACK_UNAVAILABLE', '本地音频设备没有及时就绪，未提交 TTS。'));
      this.stop('LOCAL_PLAYBACK_UNAVAILABLE');
    }, 10000);
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      let message: Record<string, unknown>;
      try { message = JSON.parse(line); } catch { return; }
      if (message.event === 'ready') { this.report.engine_ready_ms = this.elapsed(); clearTimeout(timer); readyResolve(); }
      if (message.event === 'first_render') {
        this.report.first_render_ms = this.elapsed();
        if (this.report.synthesis_completed_ms !== undefined) this.report.rendered_before_synthesis_completed = this.report.first_render_ms < this.report.synthesis_completed_ms;
        if (this.report.state === 'starting') this.report.state = 'playing';
      }
      if (message.event === 'ended') {
        this.ended = message.rendered === true;
        this.report.non_silent_output_frames = Number(message.non_silent_output_frames);
        this.report.peak = Number(message.peak);
      }
      this.save();
    });
    this.done = new Promise(resolve => {
      const close = (code: number | null) => {
        if (this.closed) return;
        this.closed = true; clearTimeout(timer); lines.close();
        if (this.report.state !== 'stopped' && this.report.state !== 'failed') {
          this.report.state = code === 0 && this.ended ? 'completed' : 'failed';
          if (this.report.state === 'failed') this.report.error = 'LOCAL_PLAYBACK_FAILED';
        }
        this.report.playback_completed_ms = this.elapsed(); this.save(); this.releaseLock();
        const error = new DomainError('LOCAL_PLAYBACK_FAILED', '本地音频输出失败；不会自动重新生成收费音频。');
        if (this.report.state === 'failed') this.controller.abort(error);
        readyReject(error); resolve();
      };
      this.child.once('error', () => close(1));
      this.child.once('close', close);
    });
    this.save();
    await ready;
  }
  async write(chunk: Buffer) {
    if (this.controller.signal.aborted || this.closed) throw this.controller.signal.reason || new DomainError('LOCAL_PLAYBACK_FAILED', '本地播放已结束。');
    this.report.first_chunk_ms ??= this.elapsed();
    this.report.chunks++; this.report.pcm_bytes += chunk.length;
    await new Promise<void>((resolve, reject) => this.child.stdin.write(chunk, error => error ? reject(new DomainError('LOCAL_PLAYBACK_FAILED', '音频输出通道已关闭。')) : resolve()));
  }
  finish() {
    this.report.synthesis_completed_ms = this.elapsed();
    this.report.rendered_before_synthesis_completed = this.report.first_render_ms !== undefined && this.report.first_render_ms < this.report.synthesis_completed_ms;
    this.save(); this.child.stdin.end();
  }
  stop(reason = 'PLAYBACK_STOPPED') {
    if (this.closed) return;
    this.report.state = reason === 'PLAYBACK_STOPPED' ? 'stopped' : 'failed'; this.report.error = reason;
    this.controller.abort(new DomainError(reason, '语音播放已停止，未自动重试。', 409));
    this.child?.kill('SIGTERM');
    this.save();
  }
  async wait() { await this.done; return { ...this.report }; }
  get active() { return !this.closed; }
}
