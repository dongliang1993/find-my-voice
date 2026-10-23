import { randomUUID } from 'node:crypto';
import type { Brain, BrainEvent, BrainFactory } from '../brain/types.js';
import type { AudioInfo, ChatMessage, CompanionStatus, InitiativeKind, ServerEvent } from '../../shared/protocol.js';
import type { ChatStore } from './store.js';

export type VoiceSpeaker = {
  speak(audioId: string, text: string, options: { onChunk: (pcm: Buffer) => void; signal?: AbortSignal }): Promise<{ durationSeconds: number }>;
};

export type ChatServiceOptions = {
  store: ChatStore;
  createBrain: BrainFactory;
  voice: VoiceSpeaker;
  /**
   * Changes whenever the persona prompt would render differently (MEMORY.md or
   * IDENTITY.md edited, a new day). A long-lived brain is rebuilt when it does.
   */
  promptVersion?: () => string;
  onLog?: (line: string) => void;
};

export type SpeakUpRequest = { kind: InitiativeKind; reason: string; followupId?: string };
/** `stopped`: the user hit stop mid-turn. Distinct from `passed`, which is her own choice. */
export type SpeakUpOutcome = 'spoke' | 'passed' | 'stopped' | 'busy' | 'failed';
export type SpeakUpResult = { outcome: SpeakUpOutcome; messages: ChatMessage[] };

type Listener = (event: ServerEvent) => void;
type VoiceJob = { controller: AbortController; done: Promise<void> };
type Job =
  | { type: 'reply'; texts: string[] }
  | { type: 'speak_up'; request: SpeakUpRequest; settle: (result: SpeakUpResult) => void };

const RECENT_CLIENT_IDS = 200;
const PASS = /^\s*PASS\s*[.。]?\s*$/i;

/** The note she gets when she might speak first. Never stored or shown. */
const nudge = (reason: string) => `[系统提示，对方看不到这条] ${reason}
如果你觉得现在想主动和对方说点什么，就直接说，像你平时发消息一样自然；不用提到这条提示，也不要说"我注意到"之类的话。
主动找人时只说一句短短的话：要么一条文字，要么一条语音，不要两样都发，也不要换个说法再说一遍。
如果现在不适合打扰对方，或者没什么想说的，只回复 PASS 这四个字母。`;

/**
 * Owns the conversation: persists messages, drives the brain one turn at a
 * time and fans every change out to connected browsers. User messages and
 * her own initiatives share one queue, so they never talk over each other.
 * Messages that arrive mid-reply are answered together, the way people double-text.
 */
export class ChatService {
  private listeners = new Set<Listener>();
  private brain: Brain | null = null;
  private brainVersion: string | null = null;
  private status: CompanionStatus = 'idle';
  private seenClientIds: string[] = [];
  private jobs: Job[] = [];
  private loop: Promise<void> | null = null;
  private voiceJobs = new Map<string, VoiceJob>();
  /** Bumped by interrupt(); a buffered initiative turn that sees it changed is discarded. */
  private interruptions = 0;

  constructor(private options: ChatServiceOptions) {}

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  snapshot(): Extract<ServerEvent, { type: 'hello' }> {
    return { type: 'hello', messages: this.options.store.recent(), status: this.status };
  }

  /** A turn is running or waiting; the initiative scheduler stays out of the way. */
  get busy() { return this.loop !== null; }

  private emit(event: ServerEvent) {
    for (const listener of this.listeners) {
      try { listener(event); }
      catch (error) { this.options.onLog?.(`listener failed: ${(error as Error).message}`); }
    }
  }

  private setStatus(status: CompanionStatus) {
    this.status = status;
    this.emit({ type: 'status', status });
  }

  private publish(message: ChatMessage) {
    this.emit({ type: 'message', message });
    return message;
  }

  private ensureBrain(fresh = false): Brain {
    const version = this.options.promptVersion?.() ?? null;
    if (this.brain && !this.brain.closed && version !== this.brainVersion) {
      // Persona changed since this brain started; its system prompt is stale.
      void this.brain.close();
      this.brain = null;
    }
    if (!this.brain || this.brain.closed) {
      this.brain = this.options.createBrain({ fresh });
      this.brainVersion = version;
    }
    return this.brain;
  }

  /** Recreate the brain on the next message, e.g. after settings or persona changed. */
  async resetBrain() {
    const old = this.brain;
    this.brain = null;
    await old?.close();
  }

  /** Stores the message and makes sure a reply loop is running. Resolves when the conversation goes idle. */
  send(clientId: string, text: string): Promise<void> {
    // Reconnecting browsers may resend; the client id makes sending idempotent.
    if (this.seenClientIds.includes(clientId)) return this.loop ?? Promise.resolve();
    this.seenClientIds = [...this.seenClientIds, clientId].slice(-RECENT_CLIENT_IDS);
    this.publish(this.options.store.append({ role: 'user', kind: 'text', text }));
    // Consecutive messages waiting in line are answered as one turn.
    const last = this.jobs.at(-1);
    if (last?.type === 'reply') last.texts.push(text);
    else this.jobs.push({ type: 'reply', texts: [text] });
    return this.start();
  }

  /**
   * Offers her a chance to speak first. Only when idle: never interrupts a
   * conversation in progress. She may decline (PASS), which leaves no trace.
   */
  speakUp(request: SpeakUpRequest): Promise<SpeakUpResult> {
    if (this.busy) return Promise.resolve({ outcome: 'busy', messages: [] });
    return new Promise(settle => {
      this.jobs.push({ type: 'speak_up', request, settle });
      void this.start();
    });
  }

  /**
   * A scripted line during onboarding: fixed text, no model in the loop. It
   * enters the history the same way any other message does — so a later
   * "she remembers" has something to remember — and when spoken, it resolves
   * only after the audio finished, which is what paces the onboarding steps.
   * Returns the message id and, for spoken lines, the audio id to wait on.
   */
  narrate(text: string, { speak = false, emotion = null }: { speak?: boolean; emotion?: string | null } = {}): { messageId: string; audioId: string | null } {
    if (!speak) {
      return { messageId: this.publish(this.options.store.append({ role: 'assistant', kind: 'text', text })).id, audioId: null };
    }
    // startVoice keys its job by the audio id, not the message id.
    const audioId = randomUUID();
    const messageId = this.startVoice(text, emotion, null, audioId);
    return { messageId, audioId };
  }

  /** Resolves when a narrated voice line finished playing, failing or not. */
  async narrateDone(audioId: string): Promise<void> {
    await this.voiceJobs.get(audioId)?.done;
  }

  private start() {
    if (!this.loop) this.loop = this.drain().finally(() => { this.loop = null; });
    return this.loop;
  }

  private async drain() {
    this.setStatus('thinking');
    try {
      for (let job = this.jobs.shift(); job; job = this.jobs.shift()) {
        if (job.type === 'reply') await this.runReply(job.texts.join('\n'));
        else job.settle(await this.runSpeakUp(job.request));
      }
    } finally {
      this.setStatus('idle');
    }
  }

  private async runReply(text: string) {
    try {
      await this.runTurn(text, { initiative: null });
    } catch (error) {
      this.options.onLog?.(`turn failed: ${(error as Error).stack ?? error}`);
      this.emit({ type: 'error', code: 'BRAIN_UNAVAILABLE', message: '我这边好像出了点问题，稍后再试试？' });
    }
  }

  private async runSpeakUp(request: SpeakUpRequest): Promise<SpeakUpResult> {
    const before = this.interruptions;
    try {
      const ids = await this.runTurn(nudge(request.reason), { initiative: request.kind, isStopped: () => this.interruptions !== before });
      if (this.interruptions !== before) return { outcome: 'stopped', messages: [] };
      if (!ids.length) return { outcome: 'passed', messages: [] };
      this.emit({ type: 'initiative', kind: request.kind, messageIds: ids });
      return { outcome: 'spoke', messages: ids.map(id => this.options.store.get(id)).filter(m => m !== null) };
    } catch (error) {
      // Unprompted turns fail quietly: an error toast she "sent" on her own makes no sense.
      this.options.onLog?.(`speak up failed: ${(error as Error).stack ?? error}`);
      return { outcome: 'failed', messages: [] };
    }
  }

  /** Stops her mid-reply: the current turn, anything queued behind it, and any voice still being made. */
  async interrupt() {
    this.interruptions++;
    for (const job of this.jobs) if (job.type === 'speak_up') job.settle({ outcome: 'stopped', messages: [] });
    this.jobs = [];
    for (const job of this.voiceJobs.values()) job.controller.abort();
    await this.brain?.interrupt();
  }

  /**
   * Runs one brain turn and returns the ids of the messages it produced.
   * Initiative turns are buffered: she might answer PASS, and that must not
   * flash on screen as it streams in.
   */
  private async runTurn(text: string, { initiative, fresh = false, isStopped = () => false }: {
    initiative: InitiativeKind | null; fresh?: boolean; isStopped?: () => boolean;
  }): Promise<string[]> {
    const { store } = this.options;
    const ids: string[] = [];
    const live = initiative === null;
    const buffered: ({ kind: 'text'; text: string } | { kind: 'voice'; text: string; emotion: string | null })[] = [];
    // The current text bubble; a voice message closes it so later text starts a new one.
    let bubble: ChatMessage | null = null;
    let pending = '';
    let lost = false;

    const closeBubble = () => {
      if (bubble) { this.publish(store.update(bubble.id, { text: bubble.text.trim() })); ids.push(bubble.id); }
      if (pending.trim()) buffered.push({ kind: 'text', text: pending.trim() });
      bubble = null;
      pending = '';
    };
    const onEvent = (event: BrainEvent) => {
      if (event.type === 'text_delta') {
        if (!live) { pending += event.text; return; }
        if (!bubble) {
          if (!event.text.trim()) return;
          bubble = this.publish(store.append({ role: 'assistant', kind: 'text', text: '' }));
        }
        bubble = { ...bubble, text: bubble.text + event.text };
        this.emit({ type: 'text_delta', messageId: bubble.id, delta: event.text });
      } else if (event.type === 'voice') {
        closeBubble();
        if (live) ids.push(this.startVoice(event.text, event.emotion, null));
        else buffered.push({ kind: 'voice', text: event.text, emotion: event.emotion });
      } else if (event.type === 'session_lost') {
        lost = true;
      } else {
        this.emit({ type: 'error', code: event.code, message: event.message });
      }
    };
    await this.ensureBrain(fresh).reply(text, onEvent);
    closeBubble();

    if (lost) {
      // The stored session is gone (data cleared, expired). Answer this same turn from
      // a new session; the chat history itself lives in our store and is unaffected.
      await this.resetBrain();
      if (fresh) {
        this.emit({ type: 'error', code: 'BRAIN_SESSION_UNAVAILABLE', message: '没能开启新的对话，稍后再试试？' });
        return ids;
      }
      return this.runTurn(text, { initiative, fresh: true, isStopped });
    }

    // Stopped mid-turn: whatever she had buffered was never shown, so it is simply dropped.
    if (!live && !isStopped()) {
      const said = buffered.filter(part => !(part.kind === 'text' && PASS.test(part.text)));
      for (const part of said) {
        ids.push(part.kind === 'voice'
          ? this.startVoice(part.text, part.emotion, initiative)
          : this.publish(store.append({ role: 'assistant', kind: 'text', text: part.text, initiative })).id);
      }
    }
    return ids;
  }

  private startVoice(text: string, emotion: string | null, initiative: InitiativeKind | null, audioId = randomUUID()): string {
    const { store, voice } = this.options;
    const audio = (patch: Partial<AudioInfo>): AudioInfo => ({ id: audioId, state: 'streaming', durationSeconds: null, error: null, ...patch });
    const message = this.publish(store.append({ role: 'assistant', kind: 'voice', text, emotion, audio: audio({}), initiative }));
    const controller = new AbortController();
    const done = voice.speak(audioId, text, {
      signal: controller.signal,
      onChunk: pcm => this.emit({ type: 'audio_chunk', audioId, data: pcm.toString('base64') }),
    }).then(
      ({ durationSeconds }) => {
        this.publish(store.update(message.id, { audio: audio({ state: 'ready', durationSeconds }) }));
      },
      (error: Error) => {
        if (controller.signal.aborted) {
          this.publish(store.update(message.id, { audio: audio({ state: 'stopped' }) }));
          return;
        }
        this.options.onLog?.(`voice failed: ${error.message}`);
        this.publish(store.update(message.id, { audio: audio({ state: 'failed', error: error.message }) }));
      },
    ).finally(() => { this.voiceJobs.delete(audioId); });
    this.voiceJobs.set(audioId, { controller, done });
    return message.id;
  }

  async close() {
    this.interruptions++;
    for (const job of this.jobs) if (job.type === 'speak_up') job.settle({ outcome: 'stopped', messages: [] });
    this.jobs = [];
    const jobs = [...this.voiceJobs.values()];
    for (const job of jobs) job.controller.abort();
    await Promise.allSettled(jobs.map(job => job.done));
    await this.brain?.close();
  }
}
