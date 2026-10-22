import type { ChatStore } from '../chat/store.js';
import type { SpeakUpRequest, SpeakUpResult } from '../chat/service.js';
import { decideCandidate, localDay, type InitiativeRules } from './gate.js';

export type InitiativeSchedulerOptions = {
  store: ChatStore;
  chat: { readonly busy: boolean; speakUp(request: SpeakUpRequest): Promise<SpeakUpResult> };
  memory: { run(): Promise<unknown> };
  rules: () => InitiativeRules;
  /** Tells the user she said something while they may not be looking (system notification). */
  notify?: (text: string) => void;
  now?: () => Date;
  onLog?: (line: string) => void;
};

const MORNING_KEY = 'initiative_morning_day';
/** The user's last-message time when a missed-you was last offered: one offer per silence. */
const MISS_YOU_KEY = 'initiative_miss_you_after';
/** Memory is extracted once the conversation has been quiet this long. */
const SETTLE_MS = 10 * 60_000;
const TICK_MS = 60_000;
/** After a failure, wait this long before calling the model for that job again. */
const BACKOFF_MS = 30 * 60_000;

/**
 * The heartbeat behind "she reaches out". Each tick it lets memory catch up on
 * a conversation that has gone quiet, then asks the gate whether there is a
 * reason to speak first. The brain still has the final word and may stay silent.
 */
export class InitiativeScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  // In memory on purpose: a restart is a reasonable moment to try again.
  private speakBlockedUntil = 0;
  private memoryBlockedUntil = 0;

  constructor(private options: InitiativeSchedulerOptions) {}

  private now() { return this.options.now?.() ?? new Date(); }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass. Overlapping calls share the pass in progress instead of doubling up. */
  tick(): Promise<void> {
    this.running ??= this.pass().catch(error => {
      this.options.onLog?.(`initiative tick failed: ${(error as Error).stack ?? error}`);
    }).finally(() => { this.running = null; });
    return this.running;
  }

  private async pass() {
    const { store, chat } = this.options;
    if (chat.busy) return;
    const now = this.now();
    const last = store.lastSpoke();
    const lastActivity = Math.max(last.user?.getTime() ?? 0, last.assistant?.getTime() ?? 0);

    // Remember first, so a follow-up mentioned in this conversation is already known.
    if (lastActivity && now.getTime() - lastActivity >= SETTLE_MS && now.getTime() >= this.memoryBlockedUntil) {
      try { await this.options.memory.run(); }
      catch (error) {
        this.memoryBlockedUntil = now.getTime() + BACKOFF_MS;
        this.options.onLog?.(`memory extraction failed, retrying in 30 min: ${(error as Error).message}`);
      }
    }
    if (now.getTime() < this.speakBlockedUntil) return;

    const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
    const candidate = decideCandidate(this.options.rules(), {
      now, lastUserAt: last.user, lastAssistantAt: last.assistant,
      lastInitiativeAt: store.lastInitiativeAt(), initiativesToday: store.initiativesSince(midnight),
      lastMorningDay: store.getState(MORNING_KEY), dueFollowups: store.dueFollowups(now), busy: chat.busy,
    });
    if (!candidate) return;
    // One missed-you offer per silence: if she let it pass, wait until the user speaks again.
    if (candidate.kind === 'miss_you' && store.getState(MISS_YOU_KEY) === last.user?.toISOString()) return;

    this.options.onLog?.(`speaking up? ${candidate.kind}`);
    const { outcome, messages } = await chat.speakUp(candidate);
    this.options.onLog?.(`speak up: ${outcome}`);
    if (outcome === 'failed') this.speakBlockedUntil = now.getTime() + BACKOFF_MS;
    // Busy or stopped by the user: nothing was decided, so the moment stays open.
    if (outcome !== 'spoke' && outcome !== 'passed') return;

    // Settled either way: once she has been offered the moment, it is not offered again.
    if (candidate.followupId) store.resolveFollowup(candidate.followupId);
    if (candidate.kind === 'morning') store.setState(MORNING_KEY, localDay(now));
    if (candidate.kind === 'miss_you' && last.user) store.setState(MISS_YOU_KEY, last.user.toISOString());
    const first = messages[0];
    if (first) this.options.notify?.(first.kind === 'voice' ? '给你发了一条语音' : first.text);
  }
}
