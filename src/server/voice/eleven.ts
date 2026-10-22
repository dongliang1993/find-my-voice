import { DomainError } from '../errors.js';
import type { ElevenModel, SpeechLanguage } from '../../shared/protocol.js';
import { pcmToWav, type SynthesisInput, type SynthesisOptions, type SynthesisResult, type TtsProvider } from './provider.js';

// ElevenLabs TTS: POST /v1/text-to-speech/{voice_id}/stream with an xi-api-key header.
// We ask for raw PCM at the app's native 24 kHz / 16-bit / mono, so the response
// streams straight to the player with no header parsing.
const ENDPOINT = 'https://api.elevenlabs.io/v1/text-to-speech';
const OUTPUT_FORMAT = 'pcm_24000';
const SAMPLE_RATE = 24000;
const BYTES_PER_SAMPLE = 2;
const MAX_BYTES = 25 * 1024 * 1024;

export const ELEVEN_MODELS = [
  'eleven_multilingual_v2', 'eleven_v4', 'eleven_v4_turbo', 'eleven_flash_v2_5',
] as const satisfies readonly ElevenModel[];

export type ElevenConfig = {
  apiKey: string;
  model: ElevenModel;
  /** `auto` guesses from the text; `zh` / `en` force that normalizer. */
  language: SpeechLanguage;
  /** 0..1. Lower is more expressive, higher is flatter. */
  stability: number;
  /** 0..1. How tightly the output tracks the stored voice. */
  similarity: number;
  timeoutMs: number;
};

const FAILURES: Record<number, [string, string]> = {
  401: ['TTS_PERMISSION_DENIED', 'ElevenLabs 鉴权失败，请检查 API Key。'],
  402: ['TTS_QUOTA_EXCEEDED', 'ElevenLabs 额度不足，请在控制台补充。'],
  403: ['TTS_PERMISSION_DENIED', 'ElevenLabs 拒绝了请求，当前 Key 没有这个音色或模型的权限。'],
  404: ['TTS_VOICE_NOT_FOUND', '找不到这个 ElevenLabs 音色，请检查音色 ID。'],
  422: ['TTS_INVALID_INPUT', 'ElevenLabs 拒绝了文本或参数。'],
  429: ['TTS_QUOTA_EXCEEDED', 'ElevenLabs 请求太频繁或并发超限，稍后再试。'],
};

// ElevenLabs' speed multiplier only spans 0.7–1.2; our speechRate is -50..100.
const speedFor = (speechRate: number) => Math.min(1.2, Math.max(0.7, 1 + speechRate / 100));

/** multilingual_v2 rejects the hint outright, so it never gets one. */
const supportsLanguageHint = (model: ElevenModel) => model !== 'eleven_multilingual_v2';
/** A coarse guess used only in `auto`: any CJK character means Chinese. */
const looksChinese = (text: string) => /[㐀-鿿]/.test(text);

export class ElevenLabsProvider implements TtsProvider {
  constructor(private config: ElevenConfig, private fetchImpl: typeof fetch = fetch) {}

  async synthesize(input: SynthesisInput, options: SynthesisOptions = {}): Promise<SynthesisResult> {
    if (!this.config.apiKey) throw new DomainError('SETUP_REQUIRED', '还没有配置 ElevenLabs API Key，请在设置中填写。');
    const voiceId = input.voice.id;
    if (!voiceId) throw new DomainError('SETUP_REQUIRED', '还没有选择 ElevenLabs 音色，请在设置中填写音色 ID。');

    const url = `${ENDPOINT}/${encodeURIComponent(voiceId)}/stream?output_format=${OUTPUT_FORMAT}`;
    const signal = AbortSignal.any([AbortSignal.timeout(this.config.timeoutMs), ...(options.signal ? [options.signal] : [])]);
    const language = this.languageFor(input);
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST', signal,
        headers: { 'xi-api-key': this.config.apiKey, 'Content-Type': 'application/json', Accept: 'audio/pcm' },
        body: JSON.stringify({
          text: input.text,
          model_id: this.config.model,
          ...(language ? { language_code: language } : {}),
          voice_settings: {
            stability: this.config.stability,
            similarity_boost: this.config.similarity,
            speed: speedFor(input.speechRate),
            use_speaker_boost: true,
          },
        }),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const [code, message] = FAILURES[response.status] ?? ['TTS_REJECTED', `ElevenLabs 语音生成失败（HTTP ${response.status}）。`];
        throw new DomainError(code, message, response.status >= 500 ? 502 : response.status, { provider_status: response.status });
      }
      if (!response.body) throw new DomainError('TTS_INCOMPLETE', 'ElevenLabs 没有返回音频数据流。');
      return await this.stream(response.body, options);
    } catch (error) {
      if (options.signal?.aborted) throw new DomainError('PLAYBACK_STOPPED', '语音已停止，未自动重新生成。', 409);
      if (error instanceof DomainError) throw error;
      if (error instanceof Error && /timeout|abort/i.test(error.name)) throw new DomainError('TTS_TIMEOUT', 'ElevenLabs 请求超时，生成状态未知。', 504);
      throw new DomainError('TTS_CONNECTION_UNKNOWN', 'ElevenLabs 连接中断，生成状态未知。未自动重试。', 502);
    }
  }

  /** Returns the language hint to send, or null to let the model decide. */
  private languageFor(input: SynthesisInput): SpeechLanguage | null {
    if (!supportsLanguageHint(this.config.model)) return null;
    // An explicit setting from the caller wins; otherwise fall back to guessing.
    if (input.language) return input.language;
    if (this.config.language !== 'auto') return this.config.language;
    return looksChinese(input.text) ? 'zh' : 'en';
  }

  private async stream(body: ReadableStream<Uint8Array>, options: SynthesisOptions): Promise<SynthesisResult> {
    let pending = Buffer.alloc(0);
    const pcm: Buffer[] = [];
    let total = 0;
    for await (const piece of body) {
      pending = Buffer.concat([pending, Buffer.from(piece)]);
      // Only hand over whole 16-bit samples; an odd trailing byte waits for the next piece.
      const usable = pending.length - (pending.length % BYTES_PER_SAMPLE);
      if (!usable) continue;
      const chunk = Buffer.from(pending.subarray(0, usable));
      pending = pending.subarray(usable);
      total += chunk.length;
      if (total > MAX_BYTES) throw new DomainError('TTS_TOO_LARGE', 'ElevenLabs 音频超出本地大小限制。');
      pcm.push(chunk);
      await options.onAudioChunk?.(chunk);
    }
    if (!total) throw new DomainError('TTS_INCOMPLETE', 'ElevenLabs 没有返回任何音频。');
    // Callers stream raw PCM; the returned copy is archived as WAV.
    return { audio: pcmToWav(Buffer.concat(pcm), SAMPLE_RATE), extension: 'wav', mime: 'audio/wav', durationSeconds: total / (SAMPLE_RATE * BYTES_PER_SAMPLE) };
  }
}
