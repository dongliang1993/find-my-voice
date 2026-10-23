import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../errors.js';
import type { SpeechLanguage } from '../../shared/protocol.js';
import type { Transcriber, TranscriberConfig, Transcript, TranscribeOptions } from './transcriber.js';

// Volcengine's flash recording-file recognition: one request in, one
// transcript out, no polling. It takes base64 audio, which suits the short
// clip from a browser recorder.
const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash';
const RESOURCE_ID = 'volc.bigasr.auc_turbo';
const OK = '20000000';
const SILENT = '20000003';

/** Volcengine names languages by tag; `auto` sends none and lets it infer. */
const LANGUAGES: Record<Exclude<SpeechLanguage, 'auto'>, string> = { zh: 'zh-CN', en: 'en-US' };
/** Container formats the endpoint accepts, keyed by the mime the page sent. */
const FORMATS: Record<string, string> = {
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/mp4': 'mp4', 'audio/m4a': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3',
};

/** Only the field we read; the response carries per-word timing we do not use. */
const responseSchema = z.object({ result: z.object({ text: z.string().default('') }) });

const FAILURES: Record<string, [string, string]> = {
  '45000001': ['STT_INVALID_INPUT', '火山引擎说这段录音的参数不对。'],
  '45000002': ['STT_INVALID_INPUT', '录音是空的。'],
  '45000151': ['STT_INVALID_INPUT', '火山引擎认不出这个音频格式。'],
  '55000031': ['STT_REJECTED', '火山引擎正忙，稍后再试。'],
};

export class VolcengineTranscriber implements Transcriber {
  constructor(private config: TranscriberConfig, private fetchImpl: typeof fetch = fetch) {}

  async transcribe(audio: Buffer, { mime, language }: TranscribeOptions): Promise<Transcript> {
    if (!this.config.apiKey) throw new DomainError('SETUP_REQUIRED', '还没有配置火山引擎 API Key，请在设置中填写。');
    const format = FORMATS[mime];
    if (!format) throw new DomainError('STT_INVALID_INPUT', `火山引擎不认识这个音频格式（${mime}）。`);

    let response: Response;
    try {
      response = await this.fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': this.config.apiKey,
          'X-Api-Resource-Id': RESOURCE_ID,
          'X-Api-Request-Id': randomUUID(),
          'X-Api-Sequence': '-1',
        },
        body: JSON.stringify({
          user: { uid: 'find-my-voice' },
          audio: { data: audio.toString('base64'), format, ...(language ? { language: LANGUAGES[language] } : {}) },
          // Punctuation and number normalisation: this text may land in a name field.
          request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true },
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && /timeout|abort/i.test(error.name)) throw new DomainError('STT_TIMEOUT', '火山引擎语音识别超时。', 504);
      throw new DomainError('STT_CONNECTION_UNKNOWN', '连不上火山引擎语音识别。', 502);
    }

    // A failed recognition still comes back as HTTP 200; the verdict is the header.
    const code = response.headers.get('x-api-status-code') ?? '';
    const logId = response.headers.get('x-tt-logid') ?? '';
    const details = logId ? { log_id: logId } : {};
    if (!response.ok || code !== OK) await response.body?.cancel().catch(() => {});
    if (!response.ok) {
      throw new DomainError(response.status === 403 ? 'STT_PERMISSION_DENIED' : 'STT_REJECTED',
        response.status === 403
          ? '当前 API Key 没有语音识别权限，请在火山控制台开通「录音文件识别极速版」。'
          : `火山引擎语音识别失败（HTTP ${response.status}）。`,
        response.status >= 500 ? 502 : response.status, details);
    }
    if (code === SILENT) return { text: '', language: '' };
    if (code !== OK) {
      const [failure, message] = FAILURES[code] ?? ['STT_REJECTED', '火山引擎语音识别失败。'];
      throw new DomainError(failure, message, 502, { ...details, provider_code: code });
    }

    const parsed = responseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new DomainError('STT_INCOMPLETE', '火山引擎没有返回可用的识别结果。', 502);
    return { text: parsed.data.result.text.trim(), language: '' };
  }
}
