import { z } from 'zod';
import { DomainError } from '../errors.js';
import type { Transcriber, TranscriberConfig, Transcript, TranscribeOptions } from './transcriber.js';

// ElevenLabs Scribe: POST /v1/speech-to-text, multipart, xi-api-key header.
// One short clip in, one transcript out — the batch endpoint suits a name
// said in a few seconds; nothing here needs words as they are spoken.
const ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text';
const MODEL = 'scribe_v2';

const FAILURES: Record<number, [string, string]> = {
  401: ['STT_PERMISSION_DENIED', 'ElevenLabs 鉴权失败，请检查 API Key。'],
  402: ['STT_QUOTA_EXCEEDED', 'ElevenLabs 额度不足，请在控制台补充。'],
  403: ['STT_PERMISSION_DENIED', 'ElevenLabs 拒绝了请求，当前 Key 没有语音识别权限。'],
  422: ['STT_INVALID_INPUT', 'ElevenLabs 没能读取这段录音。'],
  429: ['STT_QUOTA_EXCEEDED', 'ElevenLabs 请求太频繁，稍后再试。'],
};

/** Only the fields we use; anything else the API adds is ignored. */
const responseSchema = z.object({ text: z.string(), language_code: z.string().default('') });

export class ElevenLabsTranscriber implements Transcriber {
  constructor(private config: TranscriberConfig, private fetchImpl: typeof fetch = fetch) {}

  async transcribe(audio: Buffer, { mime, language }: TranscribeOptions): Promise<Transcript> {
    if (!this.config.apiKey) throw new DomainError('SETUP_REQUIRED', '还没有配置 ElevenLabs API Key，请在设置中填写。');

    const form = new FormData();
    form.append('model_id', MODEL);
    // Breaths and laughter would land in a name as "(laughter)".
    form.append('tag_audio_events', 'false');
    if (language) form.append('language_code', language);
    form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), 'answer');

    let response: Response;
    try {
      response = await this.fetchImpl(ENDPOINT, {
        method: 'POST', body: form,
        headers: { 'xi-api-key': this.config.apiKey },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && /timeout|abort/i.test(error.name)) throw new DomainError('STT_TIMEOUT', 'ElevenLabs 语音识别超时。', 504);
      throw new DomainError('STT_CONNECTION_UNKNOWN', '连不上 ElevenLabs 语音识别。', 502);
    }
    if (!response.ok) {
      // The upstream body may quote our request; it never reaches the page.
      await response.body?.cancel().catch(() => {});
      const [code, message] = FAILURES[response.status] ?? ['STT_REJECTED', `ElevenLabs 语音识别失败（HTTP ${response.status}）。`];
      throw new DomainError(code, message, response.status >= 500 ? 502 : response.status, { provider_status: response.status });
    }
    const parsed = responseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new DomainError('STT_INCOMPLETE', 'ElevenLabs 没有返回可用的识别结果。', 502);
    return { text: parsed.data.text.trim(), language: parsed.data.language_code };
  }
}
