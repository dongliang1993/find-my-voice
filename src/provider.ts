import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import type { Voice } from './catalog.js';
import { DomainError } from './errors.js';

export type SynthesisInput = { text: string; voice: Voice; speechRate: number; loudnessRate: number; direction?: string };
export type SynthesisResult = { audio: Buffer; extension: 'mp3' | 'wav'; mime: string; durationSeconds: number | null; spokenText?: string };
export type SynthesisOptions = {
  format?: 'mp3' | 'pcm'; signal?: AbortSignal;
  onAudioChunk?: (chunk: Buffer) => Promise<void>;
};
export interface TtsProvider { synthesize(input: SynthesisInput, options?: SynthesisOptions): Promise<SynthesisResult> }

// Streaming playback consumes raw signed 16-bit LE mono PCM; archives get one WAV header.
export function pcmToWav(pcm: Buffer, sampleRate = 24000): Buffer {
  if (pcm.length % 2) throw new DomainError('TTS_PROTOCOL_ERROR', 'PCM 数据没有完整的 16 位采样。');
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// HTTP chunks are arbitrary byte boundaries. Parse complete JSON objects, not network chunks.
export class JsonStreamParser {
  private buffer = ''; private cursor = 0; private start = 0; private depth = 0;
  private inString = false; private escape = false;
  write(text: string): Record<string, unknown>[] {
    this.buffer += text;
    const records: Record<string, unknown>[] = []; let consumed = 0;
    for (; this.cursor < this.buffer.length; this.cursor++) {
      const c = this.buffer[this.cursor]!;
      if (!this.depth) {
        if (/\s/.test(c)) { consumed = this.cursor + 1; continue; }
        if (c !== '{') throw new DomainError('TTS_PROTOCOL_ERROR', 'TTS 返回了非 JSON Chunked 数据。');
        this.start = this.cursor; this.depth = 1; continue;
      }
      if (this.inString) {
        if (this.escape) this.escape = false;
        else if (c === '\\') this.escape = true;
        else if (c === '"') this.inString = false;
        continue;
      }
      if (c === '"') this.inString = true;
      else if (c === '{' || c === '[') this.depth++;
      else if (c === '}' || c === ']') {
        this.depth--;
        if (!this.depth) {
          try { records.push(JSON.parse(this.buffer.slice(this.start, this.cursor + 1)) as Record<string, unknown>); }
          catch { throw new DomainError('TTS_PROTOCOL_ERROR', 'TTS 返回的 JSON 数据损坏。'); }
          consumed = this.cursor + 1;
        }
      }
    }
    this.buffer = this.buffer.slice(consumed); this.cursor -= consumed; this.start -= consumed;
    if (this.buffer.length > 4 * 1024 * 1024) throw new DomainError('TTS_PROTOCOL_ERROR', '单个 TTS 数据包超出大小限制。');
    return records;
  }
  finish() { if (this.depth || this.buffer.trim()) throw new DomainError('TTS_INCOMPLETE', 'TTS 数据流未完整结束，未保存可播放音频。'); }
}

export function checkProviderConfiguration(config: Config) {
  if (config.provider === 'fixture') return;
  if (!config.volc.apiKey && !(config.volc.appId && config.volc.accessKey)) {
    throw new DomainError('SETUP_REQUIRED', '请在本地 .env 配置 VOLC_API_KEY，或旧版 VOLC_APP_ID 与 VOLC_ACCESS_KEY。');
  }
}

function providerFailure(code: number, message: string, logId: string | null) {
  const safeLogId = logId && /^[a-zA-Z0-9_-]{1,160}$/.test(logId) ? logId : undefined;
  const details = { provider_code: code, ...(safeLogId ? { log_id: safeLogId } : {}) };
  if (code === 45000030 || /requested resource not granted/i.test(message)) {
    const resource = message.match(/resource_id=([a-zA-Z0-9._-]{1,100})/)?.[1];
    return new DomainError('TTS_RESOURCE_NOT_GRANTED', '当前凭证尚未获得此语音资源的调用权限，请在火山控制台开通对应服务，并检查 API Key 的授权范围。', 403,
      { ...details, ...(resource ? { resource_id: resource } : {}) });
  }
  if (/quota|balance|insufficient/i.test(message)) return new DomainError('TTS_QUOTA_EXCEEDED', '火山引擎额度或并发配额不足。', 429, details);
  if (/speaker|permission|access denied|unauthorized|authentication/i.test(message)) return new DomainError('TTS_PERMISSION_DENIED', '火山引擎鉴权或音色权限校验失败，请检查资源 ID、音色及凭证。', 403, details);
  if (/text.*limit|parameter|invalid/i.test(message)) return new DomainError('TTS_INVALID_INPUT', '火山引擎拒绝了文本或参数。', 400, details);
  return new DomainError('TTS_REJECTED', '火山引擎语音生成失败，请使用错误码与 Log ID 排查。', 502, details);
}

async function httpFailure(response: Response): Promise<DomainError> {
  const fallback = response.status === 401 || response.status === 403 ? 'permission denied' : response.status === 429 ? 'quota exceeded' : '';
  let code = response.status, message = fallback;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      let size = 0; const chunks: Uint8Array[] = [];
      while (true) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > 16 * 1024) break;
        chunks.push(next.value);
      }
      if (size <= 16 * 1024) {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body && typeof body === 'object') {
          const error = body.error && typeof body.error === 'object' ? body.error : body;
          if (typeof error.code === 'number' && Number.isFinite(error.code)) code = error.code;
          if (typeof error.message === 'string') message = error.message;
        }
      }
    } catch { /* Keep the sanitized HTTP fallback for malformed error responses. */ }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  return providerFailure(code, message, response.headers.get('x-tt-logid'));
}

export class VolcengineProvider implements TtsProvider {
  constructor(private config: Config, private fetchImpl: typeof fetch = fetch) {}
  async synthesize(input: SynthesisInput, options: SynthesisOptions = {}): Promise<SynthesisResult> {
    checkProviderConfiguration(this.config);
    const resourceId = input.voice.resource_id || this.config.volc.resourceId;
    if (!resourceId) throw new DomainError('SETUP_REQUIRED', '请配置已开通的 VOLC_RESOURCE_ID 或音色目录中的 resource_id。');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json', 'X-Api-Resource-Id': resourceId, 'X-Api-Request-Id': randomUUID(),
    };
    if (this.config.volc.apiKey) headers['X-Api-Key'] = this.config.volc.apiKey;
    else { headers['X-Api-App-Id'] = this.config.volc.appId; headers['X-Api-Access-Key'] = this.config.volc.accessKey; }
    let response: Response;
    try {
      response = await this.fetchImpl('https://openspeech.bytedance.com/api/v3/tts/unidirectional', {
        method: 'POST', headers, signal: AbortSignal.any([AbortSignal.timeout(this.config.timeoutMs), ...(options.signal ? [options.signal] : [])]),
        body: JSON.stringify({
          user: { uid: this.config.ownerId },
          req_params: { text: input.text, speaker: input.voice.id,
            audio_params: { format: options.format ?? 'mp3', sample_rate: 24000, speech_rate: input.speechRate, loudness_rate: input.loudnessRate } },
        }),
      });
      if (!response.ok) {
        // A non-2xx response is not a completed generation. Never return raw response bodies.
        throw await httpFailure(response);
      }
      if (!response.body) throw new DomainError('TTS_INCOMPLETE', 'TTS 没有返回音频数据流。');
      const parser = new JsonStreamParser(); const decoder = new TextDecoder(); const chunks: Buffer[] = [];
      let total = 0; let sawLegacyChunk = false; let sawZeroSuccess = false; let terminal = false;
      const processRecords = async (records: Record<string, unknown>[]) => {
        for (const record of records) {
          if (terminal) throw new DomainError('TTS_PROTOCOL_ERROR', 'TTS 在结束标记之后继续返回了数据。');
          const code = record.code;
          if (typeof code !== 'number') throw new DomainError('TTS_PROTOCOL_ERROR', 'TTS 数据包缺少状态码。');
          if (code !== 0 && code !== 1000 && code !== 20000000) throw providerFailure(code, typeof record.message === 'string' ? record.message : '', response.headers.get('x-tt-logid'));
          if (code === 1000) sawLegacyChunk = true;
          if (code === 0) sawZeroSuccess = true;
          if (typeof record.data === 'string' && record.data) {
            if (record.data.length % 4 !== 0 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(record.data)) throw new DomainError('TTS_PROTOCOL_ERROR', 'TTS 音频 Base64 无效。');
            const bytes = Buffer.from(record.data, 'base64'); total += bytes.length;
            if (total > 25 * 1024 * 1024) throw new DomainError('TTS_TOO_LARGE', 'TTS 音频超出本地大小限制。');
            chunks.push(bytes);
            await options.onAudioChunk?.(bytes);
          }
          if (code === 20000000) terminal = true;
        }
      };
      for await (const bytes of response.body) await processRecords(parser.write(decoder.decode(bytes, { stream: true })));
      await processRecords(parser.write(decoder.decode())); parser.finish();
      // The legacy API uses 1000/20000000; the newer API documents code 0 and clean EOF.
      if ((sawLegacyChunk && !terminal) || (!terminal && !sawZeroSuccess) || !total) {
        throw new DomainError('TTS_INCOMPLETE', 'TTS 未完整返回音频。请核对上游状态，避免盲目重试造成重复计费。');
      }
      const audio = Buffer.concat(chunks);
      return options.format === 'pcm'
        ? { audio: pcmToWav(audio), extension: 'wav', mime: 'audio/wav', durationSeconds: total / 48000 }
        : { audio, extension: 'mp3', mime: 'audio/mpeg', durationSeconds: null };
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason instanceof DomainError ? options.signal.reason : new DomainError('PLAYBACK_STOPPED', '语音已停止，未自动重新生成。', 409);
      if (error instanceof DomainError) throw error;
      if (error instanceof Error && /timeout|abort/i.test(error.name)) throw new DomainError('TTS_TIMEOUT', 'TTS 请求超时，生成状态未知。请核对供应商记录后再决定是否重试。', 504);
      throw new DomainError('TTS_CONNECTION_UNKNOWN', 'TTS 连接中断，生成状态未知。未自动重试。', 502);
    }
  }
}

export class FixtureProvider implements TtsProvider {
  async synthesize(_input?: SynthesisInput): Promise<SynthesisResult> {
    const sampleRate = 24000, seconds = 2, samples = sampleRate * seconds;
    const audio = Buffer.alloc(44 + samples * 2);
    audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
    audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
    audio.writeUInt32LE(sampleRate, 24); audio.writeUInt32LE(sampleRate * 2, 28);
    audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(samples * 2, 40);
    for (let i = 0; i < samples; i++) {
      const envelope = Math.min(1, i / 1200, (samples - i) / 1200) * 0.1;
      audio.writeInt16LE(Math.round(Math.sin(i / sampleRate * Math.PI * 2 * 440) * envelope * 32767), 44 + i * 2);
    }
    return { audio, extension: 'wav', mime: 'audio/wav', durationSeconds: seconds };
  }
}

export class SeedAudioProvider implements TtsProvider {
  constructor(private config: Config, private fetchImpl: typeof fetch = fetch) {}
  async synthesize(input: SynthesisInput): Promise<SynthesisResult> {
    checkProviderConfiguration(this.config);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Api-Request-Id': randomUUID() };
    if (this.config.volc.apiKey) headers['X-Api-Key'] = this.config.volc.apiKey;
    else { headers['X-Api-App-Id'] = this.config.volc.appId; headers['X-Api-Access-Key'] = this.config.volc.accessKey; }
    try {
      const response = await this.fetchImpl('https://openspeech.bytedance.com/api/v3/tts/create', {
        method: 'POST', headers, signal: AbortSignal.timeout(this.config.seedAudioTimeoutMs),
        body: JSON.stringify({
          model: 'seed-audio-1.0',
          text_prompt: `生成一段单人对话语音，无背景音乐或环境音。${input.direction || '使用参考音色，以自然对话方式表达。'}\n逐字说出以下引用中的台词，不朗读其他说明：${JSON.stringify(input.text)}`,
          ...(input.voice.id !== 'designed-voice' ? { references: [{ speaker: input.voice.id }] } : {}),
          audio_config: { format: 'mp3', sample_rate: 24000, speech_rate: input.speechRate, loudness_rate: input.loudnessRate, enable_subtitle: true },
        }),
      });
      if (!response.ok) throw await httpFailure(response);
      if (!response.body) throw new DomainError('TTS_INCOMPLETE', 'Seed Audio 未返回音频。');
      let size = 0; const chunks: Buffer[] = [];
      for await (const bytes of response.body) {
        size += bytes.byteLength;
        if (size > 36 * 1024 * 1024) throw new DomainError('TTS_TOO_LARGE', 'Seed Audio 响应超出本地大小限制。');
        chunks.push(Buffer.from(bytes));
      }
      let body: Record<string, unknown>;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; }
      catch { throw new DomainError('TTS_PROTOCOL_ERROR', 'Seed Audio 返回了无效 JSON。'); }
      if (body.code !== undefined && body.code !== 0 && body.code !== 20000000) throw providerFailure(Number(body.code), typeof body.message === 'string' ? body.message : '', response.headers.get('x-tt-logid'));
      if (typeof body.audio !== 'string' || !body.audio || body.audio.length % 4 !== 0 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(body.audio)) {
        throw new DomainError('TTS_INCOMPLETE', 'Seed Audio 响应中没有完整的 Base64 音频，未保存生成结果。');
      }
      const audio = Buffer.from(body.audio, 'base64');
      if (audio.length > 25 * 1024 * 1024) throw new DomainError('TTS_TOO_LARGE', 'Seed Audio 音频超出本地大小限制。');
      const duration = typeof body.duration === 'number' && Number.isFinite(body.duration) && body.duration > 0 ? body.duration : null;
      const subtitle = body.subtitle && typeof body.subtitle === 'object' ? (body.subtitle as Record<string, unknown>).text : undefined;
      return { audio, extension: 'mp3', mime: 'audio/mpeg', durationSeconds: duration,
        ...(typeof subtitle === 'string' ? { spokenText: subtitle.slice(0, 10000) } : {}) };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (error instanceof Error && /timeout|abort/i.test(error.name)) throw new DomainError('TTS_TIMEOUT', 'Seed Audio 请求超时，生成状态未知。未自动重试。', 504);
      throw new DomainError('TTS_CONNECTION_UNKNOWN', 'Seed Audio 连接中断，生成状态未知。未自动重试。', 502);
    }
  }
}
