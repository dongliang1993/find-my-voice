import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { configuredVoice, listVoices, type Voice } from './catalog.js';
import { DomainError } from './errors.js';
import { Assets } from './assets.js';
import { checkProviderConfiguration, FixtureProvider, VolcengineProvider, SeedAudioProvider, type TtsProvider } from './provider.js';
import { Store, digest, type Speech, type Pending } from './storage.js';
import { memorySaveSchema, identityUpdateSchema, voiceSpeakSchema, voiceListSchema } from './schema.js';
import { PcmPlayback, type StreamingPlayback } from './playback.js';
import { setupStatus } from './setup.js';

export class VoiceService {
  readonly store: Store; readonly assets: Assets; readonly provider: TtsProvider;
  readonly creativeProvider: TtsProvider;
  private inFlight = new Map<string, Promise<Speech>>();
  private playback?: StreamingPlayback;
  constructor(readonly config: Config, provider?: TtsProvider,
    private startPlayback: (config: Config, id: string, started: number) => Promise<StreamingPlayback> = PcmPlayback.start) {
    this.store = new Store(config.dataDir); this.assets = new Assets(config, this.store);
    this.provider = provider ?? (config.provider === 'fixture' ? new FixtureProvider() : new VolcengineProvider(config));
    this.creativeProvider = provider ?? (config.provider === 'fixture' ? new FixtureProvider() : new SeedAudioProvider(config));
    this.store.recoverStaleSpeech(Math.max(config.timeoutMs, config.seedAudioTimeoutMs)); this.assets.cleanup();
  }
  pendingResult(pending: Pending) {
    return {
      status: pending.state === 'pending' ? 'awaiting_confirmation' : pending.state,
      data: { pending_id: pending.id, kind: pending.kind, review_url: `${this.assets.baseUrl}/review/${pending.id}`,
        ...(pending.result || {}), message: pending.state === 'pending' ? '变更已准备，尚未保存为有效记忆或角色。请由用户确认。' : undefined },
    };
  }
  memorySave(input: unknown) { return this.pendingResult(this.store.stage(this.config.ownerId, 'memory', memorySaveSchema.parse(input))); }
  identityUpdate(input: unknown) {
    const update = identityUpdateSchema.parse(input);
    if (update.voice) configuredVoice(this.config, update.voice.voice_id);
    return this.pendingResult(this.store.stage(this.config.ownerId, 'identity', update));
  }
  decide(id: string, approve: boolean, indices?: number[]) {
    return this.pendingResult(this.store.decide(this.config.ownerId, id, approve, indices, voice => { configuredVoice(this.config, voice); }));
  }
  voiceList(input: unknown) {
    const options = voiceListSchema.parse(input);
    return { status: 'completed', data: {
      voices: listVoices(this.config).filter(v => (options.include_unconfigured || v.enabled) && (!options.language || v.languages.includes(options.language))),
      source_note: '首版使用服务端维护的音色目录及用户配置，不代表已向供应商实时验证账户权限。实际合成时由火山引擎再次校验。',
      supported_parameters: { speech_rate: [-50, 100], loudness_rate: [-50, 100] },
      persona_voice_selected: Boolean(this.store.snapshot(this.config.ownerId).voice),
      refreshed_at: new Date().toISOString(),
    } };
  }
  async speak(input: unknown, localPath = false, allowSystemPlayback = localPath) {
    const args = voiceSpeakSchema.parse(input);
    if (Array.from(args.text).length > this.config.maxCharacters) throw new DomainError('TEXT_TOO_LONG', `单次语音文本不能超过 ${this.config.maxCharacters} 个字符，请先调整文本。`);
    const mode = args.generation_mode ?? this.config.apiMode;
    const playback = args.playback ?? (allowSystemPlayback ? this.config.localAudioPlayback : 'none');
    if (playback === 'stream' && !allowSystemPlayback) throw new DomainError('LOCAL_PLAYBACK_ONLY', '流式系统播放只提供给本地 stdio 宿主，不能用于远程 HTTP 客户端。');
    if (playback === 'stream' && (mode !== 'tts' || this.config.provider !== 'volcengine')) throw new DomainError('STREAMING_TTS_REQUIRED', '流式播放需要真实的固定音色 TTS；Seed Audio 和测试提示音不使用此通道。');
    if (mode === 'tts' && args.speech_direction) throw new DomainError('UNSUPPORTED_PARAMETER', 'speech_direction 仅用于 Seed Audio 声音风格实验；TTS 请使用音色与语速参数。');
    if (mode === 'seed-audio' && Array.from(args.text).length > 400) throw new DomainError('TEXT_TOO_LONG', 'Seed Audio 首版将人声台词限制为 400 字，以便核对实际生成内容。');
    const inputHash = digest({ ...args, provider: this.config.provider, mode });
    const existing = this.store.speechByRequest(this.config.ownerId, args.request_id);
    if (existing) {
      if (existing.input_hash !== inputHash) throw new DomainError('REQUEST_CONFLICT', '同一请求 ID 不能用于不同文本、参数或供应商。', 409);
      const active = this.inFlight.get(args.request_id);
      const asset = active ? await active : existing;
      if (asset.state !== 'completed') throw new DomainError(asset.state === 'generating' ? 'IN_PROGRESS' : 'GENERATION_NOT_COMPLETE',
        '该请求已经提交，但未成功完成。未自动重试；请核对供应商状态。', 409, { audio_id: asset.id, generation_state: asset.state, previous_error: asset.error });
      return { status: 'completed', data: { ...this.assets.publicResult(asset, localPath), reused: true } };
    }
    checkProviderConfiguration(this.config);
    const current = this.store.snapshot(this.config.ownerId, args.role_id);
    const id = args.voice_id || current.voice?.voice_id || (this.config.provider === 'fixture' ? 'fixture-tone' : this.config.bootstrapVoice);
    if (!id && !(mode === 'seed-audio' && args.speech_direction)) throw new DomainError('VOICE_REQUIRED', '请配置音色；Seed Audio 纯描述实验也可以提供 speech_direction。');
    const voice: Voice = id ? configuredVoice(this.config, id) : {
      id: 'designed-voice', name: '声音设计样本', description: args.speech_direction!, languages: ['zh'], enabled: true,
      provider: 'volcengine', availability: 'configured', source: 'one-off prompt; no persistent speaker ID',
    };
    if (mode === 'tts' && this.config.provider !== 'fixture' && !(voice.resource_id || this.config.volc.resourceId)) throw new DomainError('SETUP_REQUIRED', '请填写 VOLC_RESOURCE_ID 或音色的 resource_id。');
    const now = Date.now();
    const candidate: Speech = {
      id: randomUUID(), owner_id: this.config.ownerId, request_id: args.request_id, input_hash: inputHash,
      role_id: args.role_id, identity_version: current.version, text: args.text, voice_id: voice.id, voice_name: voice.name,
      speech_rate: args.speech_rate ?? current.voice?.speech_rate ?? 0, loudness_rate: args.loudness_rate ?? current.voice?.loudness_rate ?? 0,
      provider: this.config.provider, state: 'generating', file_path: null, mime_type: null, duration_seconds: null,
      generation_mode: mode, direction: args.speech_direction || null, spoken_text: null,
      created_at: new Date(now).toISOString(), expires_at: new Date(now + this.config.retentionMs).toISOString(), error: null,
    };
    const reserved = this.store.reserveSpeech(candidate, this.config.maxConcurrency, this.config.requestsPerMinute);
    if (reserved.id !== candidate.id) {
      // Another process owns this request. Do not issue another paid synthesis.
      if (reserved.state === 'completed') return { status: 'completed', data: { ...this.assets.publicResult(reserved, localPath), reused: true } };
      throw new DomainError('IN_PROGRESS', '另一个进程已提交该请求，未重复调用 TTS。', 409);
    }
    const task = (async () => {
      let stream: StreamingPlayback | undefined;
      try {
        const activeProvider = mode === 'seed-audio' ? this.creativeProvider : this.provider;
        if (playback === 'stream') {
          stream = await this.startPlayback(this.config, candidate.id, performance.now());
          this.playback = stream;
        }
        const result = await activeProvider.synthesize({ text: args.text, voice, speechRate: candidate.speech_rate, loudnessRate: candidate.loudness_rate, direction: args.speech_direction },
          stream ? { format: 'pcm', signal: stream.controller.signal, onAudioChunk: bytes => stream!.write(bytes) } : undefined);
        const path = this.assets.write(candidate.id, result);
        const asset = this.store.completeSpeech(this.config.ownerId, candidate.id, path, result.mime, result.durationSeconds, result.spokenText || null);
        stream?.finish();
        return asset;
      } catch (error) {
        const code = error instanceof DomainError ? error.code : 'INTERNAL_ERROR';
        stream?.stop(code);
        const knownFailure = ['SETUP_REQUIRED', 'TTS_REJECTED', 'TTS_QUOTA_EXCEEDED', 'TTS_PERMISSION_DENIED', 'TTS_RESOURCE_NOT_GRANTED', 'TTS_INVALID_INPUT', 'LOCAL_PLAYBACK_BUSY', 'LOCAL_PLAYBACK_UNAVAILABLE', 'PLAYBACK_STOPPED'].includes(code);
        this.store.failSpeech(this.config.ownerId, candidate.id, code, !knownFailure);
        throw error;
      } finally { this.inFlight.delete(args.request_id); }
    })();
    this.inFlight.set(args.request_id, task);
    const asset = await task;
    return { status: 'completed', data: { ...this.assets.publicResult(asset, localPath), reused: false } };
  }
  context() {
    return { identity: this.store.snapshot(this.config.ownerId), memories: this.store.memories(this.config.ownerId),
      interaction: { voice_reply_mode: this.config.voiceReplyMode, local_audio_playback: this.config.localAudioPlayback },
      recent_decisions: this.store.pendingList(this.config.ownerId).slice(0, 10).map(p => ({ id: p.id, kind: p.kind, state: p.state, result: p.result })) };
  }
  setup(local = false) { return { status: 'completed', data: setupStatus(this.config, this.store, this.assets.baseUrl, local) }; }
  playbackControl(action: 'status' | 'stop') {
    if (action === 'stop') this.playback?.stop();
    return { status: 'completed', data: { audio_id: this.playback?.audioId, active: this.playback?.active ?? false, delivery: this.playback ? { ...this.playback.report } : undefined } };
  }
  async waitForPlayback() { return this.playback?.wait(); }
  async shutdown() {
    this.playback?.stop();
    await Promise.allSettled([...this.inFlight.values()]);
    await this.playback?.wait();
    this.store.close();
  }
  close() { this.playback?.stop(); this.store.close(); }
}
