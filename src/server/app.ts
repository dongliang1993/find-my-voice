import { resolve } from 'node:path';
import { loadSettings, updateSettings, type Settings, type SettingsPatch } from './config.js';
import { readClaudeSettings, resolveBrainAuth } from './brain/auth.js';
import { ClaudeBrain } from './brain/claude.js';
import type { Brain } from './brain/types.js';
import { ChatService } from './chat/service.js';
import { ChatStore } from './chat/store.js';
import { buildSystemPrompt } from './profile/profile.js';
import { VoicePipeline } from './voice/pipeline.js';
import { FixtureProvider, VolcengineProvider, type TtsProvider } from './voice/provider.js';
import { DomainError } from './errors.js';
import type { AppStatus } from '../shared/protocol.js';

const SESSION_KEY = 'brain_session';

/** Wires settings, storage, brain and voice together. One instance per process. */
export class App {
  settings: Settings;
  readonly store: ChatStore;
  readonly chat: ChatService;
  readonly voice: VoicePipeline;
  private tts: TtsProvider;

  constructor(readonly dataDir: string, readonly log: (line: string) => void = line => process.stderr.write(`${line}\n`)) {
    this.settings = loadSettings(dataDir);
    this.store = new ChatStore(dataDir);
    this.tts = this.createTts();
    this.voice = new VoicePipeline({
      // Indirection so a rebuilt provider (new key) is picked up without a new pipeline.
      provider: { synthesize: (input, options) => this.tts.synthesize(input, options) },
      audioDir: resolve(dataDir, 'audio'),
      voice: () => ({ id: this.settings.voice.voiceId, resourceId: this.settings.voice.resourceId }),
      speechRate: () => this.settings.voice.speechRate,
    });
    this.chat = new ChatService({ store: this.store, voice: this.voice, createBrain: () => this.createBrain(), onLog: log });
  }

  private brainAuth() {
    return resolveBrainAuth({ app: this.settings.brain, claudeSettings: readClaudeSettings(), processEnv: process.env });
  }

  private createTts(): TtsProvider {
    const { voice } = this.settings;
    if (voice.provider === 'fixture') return new FixtureProvider();
    return new VolcengineProvider({ apiKey: voice.apiKey, timeoutMs: voice.timeoutMs, userId: 'find-my-voice' });
  }

  private createBrain(): Brain {
    const auth = this.brainAuth();
    if (auth.source === 'none') {
      throw new DomainError('BRAIN_NOT_CONFIGURED', '还没有可用的模型凭证，请在设置里填写 API Key。');
    }
    return new ClaudeBrain({
      auth, dataDir: this.dataDir,
      systemPrompt: buildSystemPrompt(this.dataDir, { companionName: this.settings.companion.name, now: new Date() }),
      resumeSessionId: this.store.getState(SESSION_KEY),
      onSessionId: id => this.store.setState(SESSION_KEY, id),
      onLog: line => this.log(`[brain] ${line.trimEnd()}`),
    });
  }

  status(): AppStatus {
    const auth = this.brainAuth();
    const { voice, companion } = this.settings;
    return {
      companionName: companion.name,
      brain: { source: auth.source, ready: auth.source !== 'none', model: auth.model ?? null },
      voice: { provider: voice.provider, ready: voice.provider === 'fixture' || Boolean(voice.apiKey) },
    };
  }

  async updateSettings(patch: SettingsPatch) {
    this.settings = updateSettings(this.dataDir, patch);
    this.tts = this.createTts();
    // Persona or credentials may have changed; the next message starts a fresh brain process.
    if (patch.brain || patch.companion) await this.chat.resetBrain();
    return this.settings;
  }

  async close() {
    await this.chat.close();
    this.store.close();
  }
}
