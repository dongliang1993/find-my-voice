import type { ChatStore } from '../chat/store.js';
import type { SpeakUpRequest, SpeakUpResult } from '../chat/service.js';
import type { ChatMessage } from '../../shared/protocol.js';
import { decideCandidate, ECHO_SHELF_MS, FOLLOWUP_WINDOW_MS, localDay, type Candidate, type InitiativeRules } from './gate.js';
import type { Judgement } from './judge.js';

export type InitiativeSchedulerOptions = {
  store: ChatStore;
  chat: { readonly busy: boolean; speakUp(request: SpeakUpRequest): Promise<SpeakUpResult> };
  memory: { run(): Promise<unknown> };
  rules: (adapt?: { unanswered?: number }) => InitiativeRules;
  /**
   * Decides whether the candidate is actually worth saying anything about. The
   * gate can only see the clock; this sees the conversation. Left out, the gate
   * decides alone — which is what the tests want, and never how the app runs.
   */
  judge?: (candidate: Candidate, recent: ChatMessage[]) => Promise<Judgement>;
  /** See `InitiativeState.watching`: null no page, false a hidden one. */
  watching?: () => boolean | null;
  /** Tells the user she said something while they may not be looking (system notification). */
  notify?: (text: string) => void;
  now?: () => Date;
  onLog?: (line: string) => void;
};

/** The stored key keeps its old name, so a greeting already sent today still counts. */
const RHYTHM_KEY = 'initiative_morning_day';
/** Memory is extracted once the conversation has been quiet this long. */
const SETTLE_MS = 10 * 60_000;
const TICK_MS = 60_000;
/** After a failure, wait this long before calling the model for that job again. */
const BACKOFF_MS = 30 * 60_000;
/** The judge said "not now" — no point asking again on the next tick. */
const JUDGE_NO_BACKOFF_MS = 30 * 60_000;
/** How far she has stepped back after being left hanging, and since when: `{ level, since }`. */
const RESTRAINT_KEY = 'initiative_restraint';

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

  /**
   * How far she has stepped back. Down fast, up slow: each opening the user
   * leaves unanswered raises it at once; each day they come back and talk to
   * her lowers it by one. One reply is not enough to have her talking freely
   * again — trust comes back the way it does with people, a day at a time.
   */
  private restraint(now: Date): number {
    const { store } = this.options;
    const stored = JSON.parse(store.getState(RESTRAINT_KEY) ?? '{"level":0,"since":null}') as { level: number; since: string | null };
    const unanswered = store.unansweredInitiatives();
    let level = stored.level;
    let since = now;
    if (unanswered > level) level = unanswered;
    else if (unanswered === 0 && level > 0 && stored.since) {
      level = Math.max(0, level - store.daysTalkedSince(new Date(stored.since)));
      // Today has been counted: only a later day can lower it again.
      since = new Date(now); since.setHours(24, 0, 0, 0);
    }
    if (level !== stored.level) store.setState(RESTRAINT_KEY, JSON.stringify({ level, since: since.toISOString() }));
    return level;
  }

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

    // The moment for anything older than the window has passed; retire it rather than ask late.
    const expired = store.expireFollowups(new Date(now.getTime() - FOLLOWUP_WINDOW_MS));
    if (expired) this.options.onLog?.(`retired ${expired} follow-up(s) whose moment had passed`);

    const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
    const today = localDay(now);
    const asDue = (f: { id: string; topic: string; note: string; dueAt: string }) => ({ ...f, dueAt: new Date(f.dueAt) });
    const candidate = decideCandidate(this.options.rules({ unanswered: this.restraint(now) }), {
      now, lastUserAt: last.user, lastAssistantAt: last.assistant,
      lastInitiativeAt: store.lastInitiativeAt(), initiativesToday: store.initiativesSince(midnight),
      lastRhythmDay: store.getState(RHYTHM_KEY), dueFollowups: store.dueFollowups(now).map(asDue),
      laterToday: store.openFollowups().map(asDue).filter(f => f.dueAt > now && localDay(f.dueAt) === today),
      echoes: store.echoes(new Date(now.getTime() - ECHO_SHELF_MS), now).map(e => ({ ...e, saidAt: new Date(e.saidAt) })),
      lastEchoAt: store.lastInitiativeAt('echo'), daysTalked: store.daysTalked(),
      busy: chat.busy, watching: this.options.watching?.() ?? null,
    });
    if (!candidate) return;

    // The gate only knows the clock. Whether the moment is still worth anything
    // is a separate question, asked without the persona so "is there a reason"
    // cannot be talked into "yes" by a companion who wants to talk.
    // The persona gets the fact and how to say it; the judge only ever sees the fact.
    let reason = candidate.guide ? `${candidate.reason}\n${candidate.guide}` : candidate.reason;
    if (this.options.judge) {
      const judgement = await this.options.judge(candidate, store.recent(12));
      this.options.onLog?.(`judge: ${judgement.speak ? `yes — ${judgement.subject || judgement.reason}` : `no — ${judgement.reason || 'nothing behind it'}`}`);
      if (!judgement.speak) {
        // Nothing was said, and this moment is not it. Wait a while before asking
        // again — a minute from now the answer is the same, and the call is not free.
        // The follow-up stays open; the window in the gate is what retires it.
        this.speakBlockedUntil = now.getTime() + JUDGE_NO_BACKOFF_MS;
        // An echo turned down is usually turned down for what it is, not when:
        // too private, too thin. Asking again in half an hour would get the same no.
        if (candidate.echoId) store.useEcho(candidate.echoId);
        return;
      }
      // The one thing she settled on, so the persona writes about that and not
      // about whatever else it remembers.
      if (judgement.subject) reason = `${reason}\n具体想说的是：${judgement.subject}`;
    }

    this.options.onLog?.(`speaking up? ${candidate.kind}`);
    const { outcome, messages } = await chat.speakUp({ ...candidate, reason });
    this.options.onLog?.(`speak up: ${outcome}`);
    if (outcome === 'failed') this.speakBlockedUntil = now.getTime() + BACKOFF_MS;
    // Busy or stopped by the user: nothing was decided, so the moment stays open.
    if (outcome !== 'spoke' && outcome !== 'passed') return;

    // Settled either way: once she has been offered the moment, it is not offered again.
    if (candidate.followupId) store.resolveFollowup(candidate.followupId);
    if (candidate.echoId) store.useEcho(candidate.echoId);
    if (candidate.kind === 'rhythm') store.setState(RHYTHM_KEY, today);
    const first = messages[0];
    if (first) this.options.notify?.(first.kind === 'voice' ? '给你发了一条语音' : first.text);
  }
}
