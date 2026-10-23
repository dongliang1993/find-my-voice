import { resolve } from 'node:path';
import { loadSettings, resolveInitiative, updateSettings, type Settings, type SettingsPatch } from './config.js';
import { readClaudeSettings, resolveBrainAuth } from './brain/auth.js';
import { ClaudeBrain } from './brain/claude.js';
import type { Brain } from './brain/types.js';
import { ChatService } from './chat/service.js';
import { ChatStore } from './chat/store.js';
import { InitiativeScheduler } from './initiative/scheduler.js';
import { notifySystem } from './initiative/notify.js';
import { extractWithClaude } from './memory/claude.js';
import { MemoryExtractor } from './memory/extractor.js';
import { extractAliasWithClaude, plainAlias } from './profile/alias.js';
import { acceptable } from './profile/naming.js';
import { proposeNameWithClaude } from './profile/propose.js';
import { buildSystemPrompt, personaVersion, readProfileDocument, writeProfileDocument } from './profile/profile.js';
import { VoicePipeline } from './voice/pipeline.js';
import type { TtsProvider } from './voice/provider.js';
import { activeVoice, createTranscriber, createTtsProvider, listenReady, voiceReady } from './voice/registry.js';
import { DomainError } from './errors.js';
import type { AppStatus, Comfort, HeardAlias, Rhythm } from '../shared/protocol.js';

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
      promptVersion: () => personaVersion(this.dataDir,
        { companionName: this.settings.companion.name, userName: this.settings.companion.userName }, new Date()),
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
      // The gate stays a pure consumer of knobs; the mode→knobs mapping lives in config.
      rules: () => resolveInitiative(this.settings.initiative, this.settings.companion.rhythm),
      // null when no page is connected at all — then the OS notification is the
      // delivery, so she still speaks. False means a tab is there but hidden.
      watching: () => this.presence.size === 0 ? null : [...this.presence.values()].some(Boolean),
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
      systemPrompt: buildSystemPrompt(this.dataDir, {
        companionName: this.settings.companion.name, userName: this.settings.companion.userName,
        comfort: this.settings.companion.comfort, now: new Date(),
      }),
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
      listen: { ready: listenReady(voice) },
    };
  }

  /** A spoken message: the transcript, nothing else. Sending stays the page's job. */
  async hear(audio: Buffer, mime: string): Promise<string> {
    const { text } = await createTranscriber(this.settings.voice).transcribe(audio, { mime });
    return text;
  }

  /**
   * The user answered "what should I call you" aloud. Transcribes the clip and
   * takes the alias out of it. Nothing is saved here: the page shows what she
   * heard and the user confirms it, the same as a typed answer.
   */
  async hearAlias(audio: Buffer, mime: string): Promise<HeardAlias> {
    if (this.store.onboarding().completedAt) throw new DomainError('ONBOARDING_DONE', '引导已经结束了。', 409);
    const { text } = await createTranscriber(this.settings.voice).transcribe(audio, { mime });
    if (!text) return { said: '', alias: null };
    const bare = plainAlias(text);
    if (bare) return { said: text, alias: bare };
    const auth = this.brainAuth();
    if (auth.source === 'none') return { said: text, alias: null };
    const alias = await extractAliasWithClaude(auth, this.dataDir, text, line => this.log(`[alias] ${line.trimEnd()}`))
      .catch(error => { this.log(`[alias] failed: ${(error as Error).message}`); return null; });
    return { said: text, alias };
  }

  /** Onboarding progress: the step, the saved draft, and whether it is over. */
  onboarding() {
    return this.store.onboarding();
  }

  /** Saves onboarding progress; each step lands as it is reached. */
  saveOnboarding(step: number, draft: Record<string, unknown>, completed: boolean) {
    this.store.saveOnboarding(step, draft, completed);
  }

  /**
   * A scripted onboarding line. Voice lines need a configured voice; without
   * one the line is text, so onboarding degrades instead of erroring out.
   */
  narrate(text: string, { speak = false }: { speak?: boolean } = {}) {
    const canSpeak = speak && voiceReady(this.settings.voice);
    return this.chat.narrate(text, { speak: canSpeak });
  }

  /** Resolves when a narrated voice line finished (played, failed or stopped). */
  narrateDone(messageId: string) {
    return this.chat.narrateDone(messageId);
  }

  /**
   * One name proposal — exactly one. She proposes once; whatever the user
   * thinks of it, the next move is the user's own input, never a re-roll.
   */
  async proposeName(userAlias: string, notes: string): Promise<{ name: string; reason: string } | null> {
    const state = this.store.onboarding();
    if (state.completedAt) return null;
    if (state.draft.nameProposed) return null;

    const auth = this.brainAuth();
    if (auth.source === 'none') throw new DomainError('BRAIN_NOT_CONFIGURED', '还没有可用的模型凭证。');
    const proposal = await proposeNameWithClaude(auth, this.dataDir, userAlias, notes,
      line => this.log(`[naming] ${line.trimEnd()}`));
    this.store.saveOnboarding(state.step, { ...state.draft, nameProposed: true }, false);
    const name = acceptable(proposal);
    if (!name) return null;
    return { name, reason: proposal.reason };
  }

  /**
   * The last step, all at once: the names land where the rest of the app
   * already reads them, the first pages of IDENTITY.md and MEMORY.md open
   * with the story of the first meeting, and onboarding closes for good.
   * Every part is idempotent; a crash midway replays the remaining writes.
   */
  async finishOnboarding(final: {
    alias: string; companionName: string; nameOrigin: string; notes: string;
    comfort: Comfort; rhythm: Rhythm;
  }): Promise<void> {
    const state = this.store.onboarding();
    if (state.completedAt) return;

    // Everything the first meeting learned lands in one write, so the gate and
    // the prompt never see a half-finished choice.
    this.settings = updateSettings(this.dataDir, {
      companion: { name: final.companionName, userName: final.alias, comfort: final.comfort, rhythm: final.rhythm },
    });
    this.tts = createTtsProvider(this.settings.voice);

    // Her first page: who she is, including where her own name came from.
    // A file that already exists wins outright — onboarding never touches it,
    // hand-written or from an earlier run.
    const identity = readProfileDocument(this.dataDir, 'identity');
    if (identity.content === null) {
      const identityFirst = `# 我是谁\n${final.nameOrigin}\n\n# 我们怎么认识\n${new Date().toLocaleDateString('sv-SE')} 第一次见面，${final.notes ? `她第一天跟我说的是：${final.notes}` : '她第一天还没说多少话。'}`;
      try { writeProfileDocument(this.dataDir, 'identity', identityFirst, null); }
      catch (error) { if (!(error instanceof DomainError)) throw error; }
    } else {
      this.log('[onboarding] identity file exists; keeping it');
    }

    this.store.saveOnboarding(7, state.draft, true);
    // The next message starts a fresh brain with the new names in the prompt.
    await this.chat.resetBrain();
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
