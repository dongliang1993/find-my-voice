import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from './config.js';
import type { Speech, Store } from './storage.js';
import type { SynthesisResult } from './provider.js';
import { DomainError } from './errors.js';
import { readPlaybackReport } from './playback.js';

export class Assets {
  baseUrl = '';
  readonly directory: string;
  constructor(private config: Config, private store: Store) {
    this.directory = resolve(config.dataDir, 'audio');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  write(id: string, result: SynthesisResult) {
    const path = resolve(this.directory, `${id}.${result.extension}`); const temp = `${path}.tmp`;
    try { writeFileSync(temp, result.audio, { mode: 0o600 }); renameSync(temp, path); }
    finally { if (existsSync(temp)) unlinkSync(temp); }
    return path;
  }
  private signature(id: string, expiry: string) {
    return createHmac('sha256', this.config.signingKey).update(`${this.config.ownerId}:${id}:${expiry}`).digest('hex');
  }
  verify(id: string, expiry: string | undefined, signature: string | undefined) {
    if (!expiry || !signature || !/^\d{10,16}$/.test(expiry) || !/^[a-f0-9]{64}$/.test(signature) || Number(expiry) <= Date.now()) {
      throw new DomainError('LINK_EXPIRED', '音频链接已失效，请在本地管理页刷新访问链接。', 403);
    }
    const expected = this.signature(id, expiry);
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new DomainError('UNAUTHORIZED', '音频访问签名无效。', 403);
  }
  publicResult(asset: Speech, localPath = false) {
    this.assertPlayable(asset);
    const expires = Math.min(Date.now() + this.config.linkMs, Date.parse(asset.expires_at));
    const query = `expires=${expires}&signature=${this.signature(asset.id, String(expires))}`;
    return {
      audio_id: asset.id, audio_url: `${this.baseUrl}/audio/${asset.id}?${query}`,
      player_url: `${this.baseUrl}/player/${asset.id}?${query}`,
      metadata_url: `${this.baseUrl}/speech/${asset.id}?${query}`,
      text: asset.text, voice_id: asset.voice_id, voice_name: asset.voice_name,
      provider: asset.provider, is_test_audio: asset.provider === 'fixture',
      generation_mode: asset.generation_mode, speech_direction: asset.direction,
      spoken_text: asset.spoken_text, text_fidelity: asset.generation_mode === 'seed-audio' ? 'requires_review' : 'tts_input',
      voice_is_persistent: asset.voice_id !== 'designed-voice',
      identity_version: asset.identity_version, mime_type: asset.mime_type,
      duration_seconds: asset.duration_seconds, expires_at: asset.expires_at,
      delivery: readPlaybackReport(this.config, asset.id),
      ...(localPath ? { local_audio_path: asset.file_path } : {}),
    };
  }
  assertPlayable(asset: Speech) {
    if (asset.state === 'expired' || Date.parse(asset.expires_at) <= Date.now()) throw new DomainError('AUDIO_EXPIRED', '音频已超过保留期。重新生成需要发起新的请求。', 410);
    if (asset.state !== 'completed' || !asset.file_path || !existsSync(asset.file_path) || statSync(asset.file_path).size === 0) {
      throw new DomainError('AUDIO_UNAVAILABLE', '音频尚未完成、文件已删除或生成状态未知。', 409);
    }
  }
  cleanup() {
    for (const asset of this.store.expiredSpeech(this.config.ownerId)) {
      if (asset.file_path && asset.file_path.startsWith(`${this.directory}/`) && existsSync(asset.file_path)) unlinkSync(asset.file_path);
      this.store.markExpired(this.config.ownerId, asset.id);
    }
  }
}
