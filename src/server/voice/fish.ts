import { encode } from '@msgpack/msgpack';
import { DomainError } from '../errors.js';
import type { FishModel } from '../../shared/protocol.js';
import { pcmToWav, type SynthesisInput, type SynthesisOptions, type SynthesisResult, type TtsProvider } from './provider.js';

// Fish Audio TTS: POST /v1/tts with a msgpack body, Bearer auth and the model in a
// header, exactly as the official SDK (github.com/fishaudio/fish-audio-typescript) sends it.
const ENDPOINT = 'https://api.fish.audio/v1/tts';
export const FISH_MODELS = ['s1', 's1-mini', 'speech-1.6', 'speech-1.5'] as const satisfies readonly FishModel[];
export type FishConfig = { apiKey: string; model: FishModel; timeoutMs: number };

const SAMPLE_RATE = 24000;
const WAV_HEADER = 44;
const MAX_BYTES = 25 * 1024 * 1024;

const FAILURES: Record<number, [string, string]> = {
  401: ['TTS_PERMISSION_DENIED', 'Fish Audio 鉴权失败，请检查 API Key。'],
  402: ['TTS_QUOTA_EXCEEDED', 'Fish Audio 余额不足，请在控制台充值。'],
  403: ['TTS_PERMISSION_DENIED', 'Fish Audio 拒绝了请求，当前 Key 没有这个音色或模型的权限。'],
  404: ['TTS_VOICE_NOT_FOUND', '找不到这个 Fish Audio 音色，请检查音色 ID。'],
  422: ['TTS_INVALID_INPUT', 'Fish Audio 拒绝了文本或参数。'],
  429: ['TTS_QUOTA_EXCEEDED', 'Fish Audio 请求太频繁或并发超限，稍后再试。'],
};

/**
 * We ask for WAV rather than raw PCM: the header states the sample rate, depth
 * and channels, so the format is checked rather than assumed. Everything after
 * the header is raw PCM and streams straight to the player.
 */
function checkHeader(header: Buffer) {
  if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
    throw new DomainError('TTS_PROTOCOL_ERROR', 'Fish Audio 返回的不是 WAV 音频。');
  }
  const channels = header.readUInt16LE(22), sampleRate = header.readUInt32LE(24), bits = header.readUInt16LE(34);
  if (header.toString('ascii', 36, 40) !== 'data' || channels !== 1 || sampleRate !== SAMPLE_RATE || bits !== 16) {
    throw new DomainError('TTS_PROTOCOL_ERROR', `Fish Audio 返回了不支持的音频格式（${sampleRate} Hz / ${bits} bit / ${channels} 声道）。`);
  }
}

// Fish's prosody speed is a multiplier (0.5–2); our speechRate is -50..100 like Volcengine's.
const speedFor = (speechRate: number) => Math.min(2, Math.max(0.5, 1 + speechRate / 100));

export class FishAudioProvider implements TtsProvider {
  constructor(private config: FishConfig, private fetchImpl: typeof fetch = fetch) {}

  async synthesize(input: SynthesisInput, options: SynthesisOptions = {}): Promise<SynthesisResult> {
    if (!this.config.apiKey) throw new DomainError('SETUP_REQUIRED', '还没有配置 Fish Audio API Key，请在设置中填写。');
    const body = encode({
      text: input.text,
      ...(input.voice.id ? { reference_id: input.voice.id } : {}),
      format: 'wav',
      sample_rate: SAMPLE_RATE,
      latency: 'balanced',
      normalize: true,
      ...(input.speechRate ? { prosody: { speed: speedFor(input.speechRate) } } : {}),
    });
    const signal = AbortSignal.any([AbortSignal.timeout(this.config.timeoutMs), ...(options.signal ? [options.signal] : [])]);
    try {
      const response = await this.fetchImpl(ENDPOINT, {
        method: 'POST', signal, body,
        headers: { Authorization: `Bearer ${this.config.apiKey}`, model: this.config.model, 'Content-Type': 'application/msgpack' },
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const [code, message] = FAILURES[response.status] ?? ['TTS_REJECTED', `Fish Audio 语音生成失败（HTTP ${response.status}）。`];
        throw new DomainError(code, message, response.status >= 500 ? 502 : response.status, { provider_status: response.status });
      }
      if (!response.body) throw new DomainError('TTS_INCOMPLETE', 'Fish Audio 没有返回音频数据流。');
      return await this.stream(response.body, options);
    } catch (error) {
      if (options.signal?.aborted) throw new DomainError('PLAYBACK_STOPPED', '语音已停止，未自动重新生成。', 409);
      if (error instanceof DomainError) throw error;
      if (error instanceof Error && /timeout|abort/i.test(error.name)) throw new DomainError('TTS_TIMEOUT', 'Fish Audio 请求超时，生成状态未知。', 504);
      throw new DomainError('TTS_CONNECTION_UNKNOWN', 'Fish Audio 连接中断，生成状态未知。未自动重试。', 502);
    }
  }

  private async stream(body: ReadableStream<Uint8Array>, options: SynthesisOptions): Promise<SynthesisResult> {
    let pending = Buffer.alloc(0);
    let headerSeen = false;
    const pcm: Buffer[] = [];
    let total = 0;
    for await (const piece of body) {
      pending = Buffer.concat([pending, Buffer.from(piece)]);
      if (!headerSeen) {
        if (pending.length < WAV_HEADER) continue;
        checkHeader(pending.subarray(0, WAV_HEADER));
        headerSeen = true;
        pending = pending.subarray(WAV_HEADER);
      }
      // Only hand over whole 16-bit samples; an odd trailing byte waits for the next piece.
      const usable = pending.length - (pending.length % 2);
      if (!usable) continue;
      const chunk = Buffer.from(pending.subarray(0, usable));
      pending = pending.subarray(usable);
      total += chunk.length;
      if (total > MAX_BYTES) throw new DomainError('TTS_TOO_LARGE', 'Fish Audio 音频超出本地大小限制。');
      pcm.push(chunk);
      await options.onAudioChunk?.(chunk);
    }
    if (!headerSeen) throw new DomainError('TTS_INCOMPLETE', 'Fish Audio 音频不完整。');
    if (!total) throw new DomainError('TTS_INCOMPLETE', 'Fish Audio 没有返回任何音频。');
    const audio = Buffer.concat(pcm);
    return { audio: pcmToWav(audio, SAMPLE_RATE), extension: 'wav', mime: 'audio/wav', durationSeconds: total / (SAMPLE_RATE * 2) };
  }
}
