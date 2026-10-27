import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadSettings, resolveInitiative, updateSettings, type Settings, type SettingsPatch } from './config.js';
import { wakeAt } from './chat/rest.js';
import { readClaudeSettings, resolveBrainAuth } from './brain/auth.js';
import { ClaudeBrain } from './brain/claude.js';
import { ScriptBrain, type ScriptStep } from './brain/scripted.js';
import type { Brain } from './brain/types.js';
import { ChatService } from './chat/service.js';
import { ChatStore } from './chat/store.js';
import { InitiativeScheduler } from './initiative/scheduler.js';
import { buildJudgePrompt } from './initiative/judge.js';
import { judgeWithClaude } from './initiative/claude.js';
import { notifySystem } from './initiative/notify.js';
import { extractWithClaude } from './memory/claude.js';
import { MemoryExtractor } from './memory/extractor.js';
import { extractAliasWithClaude, plainAlias } from './profile/alias.js';
import { acceptable } from './profile/naming.js';
import { proposeNameWithClaude } from './profile/propose.js';
import { buildSystemPrompt, firstIdentity, personaVersion, readProfileDocument, writeProfileDocument } from './profile/profile.js';
import { VoicePipeline } from './voice/pipeline.js';
import type { TtsProvider } from './voice/provider.js';
import { activeVoice, createTranscriber, createTtsProvider, listenReady, voiceReady } from './voice/registry.js';
import { DomainError } from './errors.js';
import { DemoDirector } from './demo/director.js';
import type { DemoScript } from './demo/script.js';
import { DemoVoice } from './demo/voice.js';
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
  /** Demo mode: the script plays her part, and keeps the clock. */
  readonly demo: DemoDirector | null = null;
  private tts: TtsProvider;
  private demoVoice: DemoVoice | null = null;

  constructor(readonly dataDir: string, readonly log: (line: string) => void = line => process.stderr.write(`${line}\n`),
    { demo }: { demo?: DemoScript } = {}) {
    this.settings = loadSettings(dataDir);
    this.store = new ChatStore(dataDir, demo ? () => this.now() : undefined);
    if (demo) this.demoVoice = new DemoVoice(resolve(dataDir, 'voice-cache'), () => createTtsProvider(this.settings.voice), log);
    this.tts = this.createTts();
    this.voice = new VoicePipeline({
      // Indirection so a rebuilt provider (new key, other backend) is picked up without a new pipeline.
      provider: { synthesize: (input, options) => this.tts.synthesize(input, options) },
      audioDir: resolve(dataDir, 'audio'),
      voice: () => activeVoice(this.settings.voice),
      speechRate: () => this.settings.voice.speechRate,
      // The reply language is also the reading language: the speech is whatever
      // she just wrote. `auto` leaves it to the provider to infer from the text.
      language: () => this.settings.companion.language,
    });
    this.chat = new ChatService({
      store: this.store, voice: this.voice, onLog: log,
      canSpeak: () => this.canSpeak(),
      // Up again with the hours the first meeting said the user likes company.
      wakeAt: now => wakeAt(this.settings.companion.rhythm, now),
      createBrain: ({ fresh }) => this.createBrain(fresh),
      forgetSession: () => this.store.setState(SESSION_KEY, null),
      // Not a full settings change: the brain stays up mid-turn. A new language
      // changes the prompt version, so the next message rebuilds it anyway.
      updatePreferences: ({ language, initiative }) => {
        this.settings = updateSettings(this.dataDir, {
          ...(language ? { companion: { language } } : {}),
          ...(initiative ? { initiative: { mode: initiative } } : {}),
        });
        const { companion, initiative: now } = this.settings;
        return `改好了。回复语言：${({ auto: '跟着对方', zh: '中文', en: '英文' })[companion.language]}；主动找对方：${({ off: '不主动', occasional: '偶尔', often: '经常' })[now.mode]}。用一句口语跟对方确认。`;
      },
      promptVersion: () => personaVersion(this.dataDir, {
        companionName: this.settings.companion.name,
        userName: this.settings.companion.userName,
        language: this.settings.companion.language,
        voiceFirst: this.settings.companion.voiceFirst,
      }, new Date()),
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
      rules: ({ unanswered = 0 } = {}) => resolveInitiative(this.settings.initiative, this.settings.companion.rhythm, unanswered),
      // null when no page is connected at all — then the OS notification is the
      // delivery, so she still speaks. False means a tab is there but hidden.
      watching: () => this.presence.size === 0 ? null : [...this.presence.values()].some(Boolean),
      // No persona in the room for this one: it decides whether there is a reason
      // at all, so a companion who enjoys talking cannot talk itself into yes.
      judge: async (candidate, recent) => {
        const auth = this.brainAuth();
        if (auth.source === 'none') return { speak: false, subject: '', reason: 'no model' };
        return judgeWithClaude(auth, dataDir, buildJudgePrompt({
          candidate, recent, companionName: this.settings.companion.name, now: new Date(),
        }), line => this.log(`[judge] ${line.trimEnd()}`));
      },
      notify: text => {
        // A connected page handles it: on screen it is seen, in a background tab it raises a
        // browser notification. Ring the OS only when no page is connected at all.
        if (this.settings.initiative.notify && this.presence.size === 0) {
          notifySystem(this.settings.companion.name, text, e => this.log(`[notify] ${e.message}`));
        }
      },
    });
    if (demo) {
      this.demo = new DemoDirector(demo, this.demoVoice!, this);
      this.demo.start();
    } else {
      // Unprompted turns and memory both call the model; a demo has neither.
      this.initiative.start();
    }
  }

  /** The time as the app keeps it: the scene's in a demo. */
  now() {
    return this.demo?.now() ?? new Date();
  }

  private createTts(): TtsProvider {
    return this.demoVoice ?? createTtsProvider(this.settings.voice);
  }

  /** In a demo her voice is the takes made ahead of time, whatever the provider settings say. */
  private canSpeak() {
    return Boolean(this.demo) || voiceReady(this.settings.voice);
  }

  /** A settings write that leaves the brain alone; the demo restarts it itself when it needs to. */
  applySettings(patch: SettingsPatch) {
    this.settings = updateSettings(this.dataDir, patch);
    this.tts = this.createTts();
  }

  private brainAuth() {
    return resolveBrainAuth({ app: this.settings.brain, claudeSettings: readClaudeSettings(), processEnv: process.env });
  }

  private createBrain(fresh: boolean): Brain {
    if (this.demo) return this.demo.brain();
    // Development only: a scripted brain, so the page can be driven without a model.
    const script = process.env.FMV_BRAIN_SCRIPT;
    if (script) return new ScriptBrain(JSON.parse(readFileSync(script, 'utf8')) as ScriptStep[][], line => this.log(`[script] ${line}`));
    const auth = this.brainAuth();
    if (auth.source === 'none') {
      throw new DomainError('BRAIN_NOT_CONFIGURED', '还没有可用的模型凭证，请在设置里填写 API Key。');
    }
    return new ClaudeBrain({
      auth, dataDir: this.dataDir,
      systemPrompt: buildSystemPrompt(this.dataDir, {
        companionName: this.settings.companion.name, userName: this.settings.companion.userName,
        comfort: this.settings.companion.comfort, language: this.settings.companion.language,
        voiceFirst: this.settings.companion.voiceFirst, now: new Date(),
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
      brain: { source: auth.source, ready: auth.source !== 'none' || Boolean(process.env.FMV_BRAIN_SCRIPT) || Boolean(this.demo), model: auth.model ?? null },
      voice: { provider: voice.provider, ready: this.canSpeak() },
      // A demo still records what is said; it only never transcribes it.
      listen: { ready: Boolean(this.demo) || listenReady(voice) },
    };
  }

  /** A spoken message: the transcript, nothing else. Sending stays the page's job. */
  async hear(audio: Buffer, mime: string): Promise<string> {
    if (this.demo) return this.demo.heard(this.store.onboarding());
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
    if (this.demo) {
      const { userName } = this.demo.script.preset;
      return { said: userName, alias: userName };
    }
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
    const canSpeak = speak && this.canSpeak();
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
    if (this.demo) {
      const { herName, herNameReason } = this.demo.script.preset;
      this.store.saveOnboarding(state.step, { ...state.draft, nameProposed: true }, false);
      return { name: herName, reason: herNameReason };
    }

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
    this.tts = this.createTts();

    // Her first page: who she is, including where her own name came from.
    // A file that already exists wins outright — onboarding never touches it,
    // hand-written or from an earlier run.
    const identity = readProfileDocument(this.dataDir, 'identity');
    if (identity.content === null) {
      try { writeProfileDocument(this.dataDir, 'identity', firstIdentity(final.nameOrigin, final.notes, this.now()), null); }
      catch (error) { if (!(error instanceof DomainError)) throw error; }
    } else {
      this.log('[onboarding] identity file exists; keeping it');
    }

    this.store.saveOnboarding(7, state.draft, true);
    // The next message starts a fresh brain with the new names in the prompt.
    await this.chat.resetBrain();
    this.demo?.onboarded();
  }

  async updateSettings(patch: SettingsPatch) {
    this.settings = updateSettings(this.dataDir, patch);
    this.tts = this.createTts();
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
