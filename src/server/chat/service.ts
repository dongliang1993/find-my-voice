import { randomUUID } from 'node:crypto';
import type { Brain, BrainEvent, BrainFactory } from '../brain/types.js';
import type { AudioInfo, ChatMessage, CompanionStatus, ServerEvent } from '../../shared/protocol.js';
import type { ChatStore } from './store.js';

export type VoiceSpeaker = {
  speak(audioId: string, text: string, options: { onChunk: (pcm: Buffer) => void; signal?: AbortSignal }): Promise<{ durationSeconds: number }>;
};

export type ChatServiceOptions = {
  store: ChatStore;
  createBrain: BrainFactory;
  voice: VoiceSpeaker;
  onLog?: (line: string) => void;
};

type Listener = (event: ServerEvent) => void;
type VoiceJob = { controller: AbortController; done: Promise<void> };
const RECENT_CLIENT_IDS = 200;

/**
 * Owns the conversation: persists messages, drives the brain one turn at a
 * time and fans every change out to connected browsers. Messages that arrive
 * mid-reply are stored immediately and answered together once she is done,
 * the way people double-text.
 */
export class ChatService {
  private listeners = new Set<Listener>();
  private brain: Brain | null = null;
  private status: CompanionStatus = 'idle';
  private seenClientIds: string[] = [];
  private queued: string[] = [];
  private loop: Promise<void> | null = null;
  private voiceJobs = new Map<string, VoiceJob>();

  constructor(private options: ChatServiceOptions) {}

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  snapshot(): Extract<ServerEvent, { type: 'hello' }> {
    return { type: 'hello', messages: this.options.store.recent(), status: this.status };
  }

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
    if (!this.brain || this.brain.closed) this.brain = this.options.createBrain({ fresh });
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
    this.queued = [...this.queued, text];
    if (!this.loop) this.loop = this.drain().finally(() => { this.loop = null; });
    return this.loop;
  }

  private async drain() {
    this.setStatus('thinking');
    try {
      while (this.queued.length) {
        const batch = this.queued.join('\n');
        this.queued = [];
        try {
          await this.runTurn(batch);
        } catch (error) {
          this.options.onLog?.(`turn failed: ${(error as Error).stack ?? error}`);
          this.emit({ type: 'error', code: 'BRAIN_UNAVAILABLE', message: '我这边好像出了点问题，稍后再试试？' });
        }
      }
    } finally {
      this.setStatus('idle');
    }
  }

  /** Stops her mid-reply: the current turn, anything queued behind it, and any voice still being made. */
  async interrupt() {
    this.queued = [];
    for (const job of this.voiceJobs.values()) job.controller.abort();
    await this.brain?.interrupt();
  }

  private async runTurn(text: string, fresh = false) {
    const { store } = this.options;
    // The current text bubble; a voice message closes it so later text starts a new one.
    let bubble: ChatMessage | null = null;
    let lost = false;
    const closeBubble = () => {
      if (bubble) this.publish(store.update(bubble.id, { text: bubble.text.trim() }));
      bubble = null;
    };
    const onEvent = (event: BrainEvent) => {
      if (event.type === 'text_delta') {
        if (!bubble) {
          if (!event.text.trim()) return;
          bubble = this.publish(store.append({ role: 'assistant', kind: 'text', text: '' }));
        }
        bubble = { ...bubble, text: bubble.text + event.text };
        this.emit({ type: 'text_delta', messageId: bubble.id, delta: event.text });
      } else if (event.type === 'voice') {
        closeBubble();
        this.startVoice(event.text, event.emotion);
      } else if (event.type === 'session_lost') {
        lost = true;
      } else {
        this.emit({ type: 'error', code: event.code, message: event.message });
      }
    };
    await this.ensureBrain(fresh).reply(text, onEvent);
    closeBubble();
    if (!lost) return;
    // The stored session is gone (data cleared, expired). Answer this same message from
    // a new session; the chat history itself lives in our store and is unaffected.
    await this.resetBrain();
    if (fresh) {
      this.emit({ type: 'error', code: 'BRAIN_SESSION_UNAVAILABLE', message: '没能开启新的对话，稍后再试试？' });
      return;
    }
    await this.runTurn(text, true);
  }

  private startVoice(text: string, emotion: string | null) {
    const { store, voice } = this.options;
    const audioId = randomUUID();
    const audio = (patch: Partial<AudioInfo>): AudioInfo => ({ id: audioId, state: 'streaming', durationSeconds: null, error: null, ...patch });
    const message = this.publish(store.append({ role: 'assistant', kind: 'voice', text, emotion, audio: audio({}) }));
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
  }

  async close() {
    this.queued = [];
    const jobs = [...this.voiceJobs.values()];
    for (const job of jobs) job.controller.abort();
    await Promise.allSettled(jobs.map(job => job.done));
    await this.brain?.close();
  }
}
