import { resolve } from 'node:path';
import { loadSettings, updateSettings, type Settings, type SettingsPatch } from './config.js';
import { readClaudeSettings, resolveBrainAuth } from './brain/auth.js';
import { ClaudeBrain } from './brain/claude.js';
import type { Brain } from './brain/types.js';
import { ChatService } from './chat/service.js';
import { ChatStore } from './chat/store.js';
import { InitiativeScheduler } from './initiative/scheduler.js';
import { notifySystem } from './initiative/notify.js';
import { extractWithClaude } from './memory/claude.js';
import { MemoryExtractor } from './memory/extractor.js';
import { buildSystemPrompt, personaVersion } from './profile/profile.js';
import { VoicePipeline } from './voice/pipeline.js';
import type { TtsProvider } from './voice/provider.js';
import { activeVoice, createTtsProvider, voiceReady } from './voice/registry.js';
import { DomainError } from './errors.js';
import type { AppStatus } from '../shared/protocol.js';

const SESSION_KEY = 'brain_session';

/** Wires settings, storage, brain and voice together. One instance per process. */
export class App {
  settings: Settings;
  readonly store: ChatStore;
  readonly chat: ChatService;
  readonly voice: VoicePipeline;
  readonly memory: MemoryExtractor;
  readonly initiative: InitiativeScheduler;
  /** Each connected page and whether it is on screen right now. */
  readonly presence = new Map<symbol, boolean>();
  private tts: TtsProvider;

  constructor(readonly dataDir: string, readonly log: (line: string) => void = line => process.stderr.write(`${line}\n`)) {
    this.settings = loadSettings(dataDir);
    this.store = new ChatStore(dataDir);
    this.tts = createTtsProvider(this.settings.voice);
    this.voice = new VoicePipeline({
      // Indirection so a rebuilt provider (new key, other backend) is picked up without a new pipeline.
      provider: { synthesize: (input, options) => this.tts.synthesize(input, options) },
      audioDir: resolve(dataDir, 'audio'),
      voice: () => activeVoice(this.settings.voice),
      speechRate: () => this.settings.voice.speechRate,
      // Only providers that accept a language hint consume this; the rest ignore it.
      language: () => {
        const voice = this.settings.voice;
        return voice.provider === 'elevenlabs' ? voice.elevenlabs.language
          : voice.provider === 'volcengine' ? voice.volcengine.language
          : 'auto';
      },
    });
    this.chat = new ChatService({
      store: this.store, voice: this.voice, onLog: log,
      createBrain: ({ fresh }) => this.createBrain(fresh),
      promptVersion: () => personaVersion(this.dataDir, this.settings.companion.name, new Date()),
    });
    this.memory = new MemoryExtractor({
      store: this.store, dataDir,
      extract: prompt => {
        const auth = this.brainAuth();
        if (auth.source === 'none') throw new DomainError('BRAIN_NOT_CONFIGURED', '还没有可用的模型凭证。');
        return extractWithClaude(auth, dataDir, prompt, line => this.log(`[memory] ${line.trimEnd()}`));
      },
    });
    this.initiative = new InitiativeScheduler({
      store: this.store, chat: this.chat, memory: this.memory, onLog: line => this.log(`[initiative] ${line}`),
      rules: () => this.settings.initiative,
      notify: text => {
        // A connected page handles it: on screen it is seen, in a background tab it raises a
        // browser notification. Ring the OS only when no page is connected at all.
        if (this.settings.initiative.notify && this.presence.size === 0) {
          notifySystem(this.settings.companion.name, text, e => this.log(`[notify] ${e.message}`));
        }
      },
    });
    this.initiative.start();
  }

  private brainAuth() {
    return resolveBrainAuth({ app: this.settings.brain, claudeSettings: readClaudeSettings(), processEnv: process.env });
  }

  private createBrain(fresh: boolean): Brain {
    const auth = this.brainAuth();
    if (auth.source === 'none') {
      throw new DomainError('BRAIN_NOT_CONFIGURED', '还没有可用的模型凭证，请在设置里填写 API Key。');
    }
    return new ClaudeBrain({
      auth, dataDir: this.dataDir,
      systemPrompt: buildSystemPrompt(this.dataDir, { companionName: this.settings.companion.name, now: new Date() }),
      // A fresh brain forgets the stored id so a lost session is never resumed again.
      resumeSessionId: fresh ? null : this.store.getState(SESSION_KEY),
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
      voice: { provider: voice.provider, ready: voiceReady(voice) },
    };
  }

  async updateSettings(patch: SettingsPatch) {
    this.settings = updateSettings(this.dataDir, patch);
    this.tts = createTtsProvider(this.settings.voice);
    // Persona or credentials may have changed; the next message starts a fresh brain process.
    if (patch.brain || patch.companion) await this.chat.resetBrain();
    return this.settings;
  }

  async close() {
    this.initiative.stop();
    await this.chat.close();
    this.store.close();
  }
}
