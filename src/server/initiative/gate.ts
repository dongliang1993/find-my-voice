// Decides whether there is a reason for her to speak first, right now. Pure and
// clock-injected so every rule is testable. It only proposes; the brain still
// decides whether to actually say anything.
//
// The one principle: every opening needs a reason that can be named. Silence on
// its own is never one — "we have not talked in a while" is a push notification,
// not a thought. What gets through, most valuable first:
//   followup  something you told her about, now due
//   echo      something you said that stayed with her
//   rhythm    the hour you said you like company (the most talkative mode only)

export type InitiativeRules = {
  enabled: boolean;
  /** Local hours; a window that wraps midnight (23 → 8) is fine. */
  quietStart: number;
  quietEnd: number;
  dailyLimit: number;
  cooldownMinutes: number;
  /** Local hours of her greeting window; null means it never matches. */
  rhythmStart: number | null;
  rhythmEnd: number | null;
  /**
   * Days between two echoes; null, never. The rarest kind on purpose: the one
   * that moves people most is also the one that turns false fastest.
   */
  echoGapDays: number | null;
  /**
   * She has opened twice and been left unanswered. Only something she
   * remembered may interrupt now — the hour alone is not enough.
   */
  followupsOnly?: boolean;
  /**
   * Three in a row went unanswered. She says nothing until the user comes back:
   * talking into silence is not presence, it is noise.
   */
  silent?: boolean;
};

/** How long a due follow-up is still worth asking about. */
export const FOLLOWUP_WINDOW_MS = 48 * 3600_000;
/**
 * An echo is something that stayed with her, so it cannot come back the same
 * evening — that is just still talking about it. And after two days it is not
 * "still thinking about it" any more.
 */
export const ECHO_MIN_AGE_MS = 6 * 3600_000;
export const ECHO_SHELF_MS = 48 * 3600_000;
/**
 * Getting closer lowers the bar, it does not raise the volume. At first she
 * opens only for things with a date on them; after this many days of talking,
 * a line that stayed with her is enough.
 */
export const FAMILIAR_DAYS = 5;

export type DueFollowup = { id: string; topic: string; note: string; dueAt: Date };
export type HeldEcho = { id: string; line: string; note: string; saidAt: Date };

export type InitiativeState = {
  now: Date;
  lastUserAt: Date | null;
  lastAssistantAt: Date | null;
  lastInitiativeAt: Date | null;
  initiativesToday: number;
  /** `YYYY-MM-DD` of the last greeting on the hour. */
  lastRhythmDay: string | null;
  dueFollowups: DueFollowup[];
  /** Follow-ups due later today: what a greeting can hang on ("good luck this afternoon"). */
  laterToday?: DueFollowup[];
  /** Lines she is still holding, newest first, already within their age window. */
  echoes?: HeldEcho[];
  lastEchoAt?: Date | null;
  /** On how many different days the user has talked to her. */
  daysTalked?: number;
  /** A reply is in progress. */
  busy: boolean;
  /**
   * Is anyone looking? `true` a page is open and visible, `false` a page is
   * open but in the background, `null` no page at all — which is not the same
   * thing, because then the OS notification is the delivery and she should
   * still speak.
   */
  watching: boolean | null;
};

export type CandidateKind = 'followup' | 'echo' | 'rhythm';
/**
 * `reason` is the plain fact — what the judge weighs. `guide` is how to say it,
 * for the persona only: the judge should not be swayed by stage directions.
 */
export type Candidate = { kind: CandidateKind; reason: string; guide?: string; followupId?: string; echoId?: string };

const DAY = 24 * 3600_000;
/** Leave a live conversation alone: no unprompted message within this long of the user's last word. */
const LIVE_CONVERSATION_MS = 30 * 60_000;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export const localDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

const inWindow = (hour: number, start: number | null, end: number | null) =>
  start === null || end === null ? false : start <= end ? hour >= start && hour < end : hour >= start || hour < end;

/** What a person would call this hour. */
const partOfDay = (hour: number) =>
  hour < 5 ? '深夜' : hour < 11 ? '早上' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 21 ? '傍晚' : '晚上';

/** "昨天", "前天", "今天早些时候" — how she would place when it was said. */
function whenSaid(said: Date, now: Date) {
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(said)) / DAY);
  return days <= 0 ? '今天早些时候' : days === 1 ? '昨天' : days === 2 ? '前天' : `${days} 天前`;
}

function blocked(rules: InitiativeRules, s: InitiativeState) {
  if (!rules.enabled || rules.silent || s.busy) return true;
  // A page in the background: the reply would be written and played to nobody,
  // and the tab title is a poor place to catch up. Wait for the next tick.
  if (s.watching === false) return true;
  // Never on a brand-new install: she has nothing to go on yet.
  if (!s.lastUserAt) return true;
  if (inWindow(s.now.getHours(), rules.quietStart, rules.quietEnd)) return true;
  if (s.initiativesToday >= rules.dailyLimit) return true;
  if (s.lastInitiativeAt && s.now.getTime() - s.lastInitiativeAt.getTime() < rules.cooldownMinutes * 60_000) return true;
  return s.now.getTime() - s.lastUserAt.getTime() < LIVE_CONVERSATION_MS;
}

/**
 * The one thing she remembered that is still worth a question, if any. Anything
 * older than the window is left alone rather than asked about late: by then the
 * moment has passed, and a stale "how did it go" reads worse than silence.
 */
export function freshFollowup(s: Pick<InitiativeState, 'now' | 'dueFollowups'>): DueFollowup | null {
  return s.dueFollowups.find(f => s.now.getTime() - f.dueAt.getTime() <= FOLLOWUP_WINDOW_MS) ?? null;
}

/** A line she is still holding, if she knows the user well enough and has not used one lately. */
function heldEcho(rules: InitiativeRules, s: InitiativeState): HeldEcho | null {
  if (rules.echoGapDays === null || (s.daysTalked ?? 0) < FAMILIAR_DAYS) return null;
  if (s.lastEchoAt && s.now.getTime() - s.lastEchoAt.getTime() < rules.echoGapDays * DAY) return null;
  const age = (e: HeldEcho) => s.now.getTime() - e.saidAt.getTime();
  return s.echoes?.find(e => age(e) >= ECHO_MIN_AGE_MS && age(e) <= ECHO_SHELF_MS) ?? null;
}

export function decideCandidate(rules: InitiativeRules, s: InitiativeState): Candidate | null {
  if (blocked(rules, s)) return null;
  const lastUserAt = s.lastUserAt!;

  // Something she promised herself to ask about outranks everything else.
  const followup = freshFollowup(s);
  if (followup) {
    return {
      kind: 'followup', followupId: followup.id,
      reason: `你之前记下要关心对方的事到时间了：「${followup.topic}」${followup.note ? `（${followup.note}）` : ''}。`,
    };
  }
  // Nothing she remembered: what is left is hers, not theirs, and it is only for
  // someone who has shown up — never after she has been left hanging.
  if (rules.followupsOnly) return null;

  // Don't pile on: if her last message is still unanswered, wait for a reply.
  if (s.lastAssistantAt && s.lastAssistantAt > lastUserAt) return null;

  const echo = heldEcho(rules, s);
  if (echo) {
    return {
      kind: 'echo', echoId: echo.id,
      reason: `对方${whenSaid(echo.saidAt, s.now)}说过一句话，你到现在还会想起：「${echo.line}」${echo.note ? `（${echo.note}）` : ''}。`,
      guide: '如果你真的还在想着它，就说说你自己的念头——提到对方的原话或那个画面，不要变成提问，也不要假装刚想起来。',
    };
  }

  const today = localDay(s.now);
  const talkedToday = localDay(lastUserAt) === today;
  if (inWindow(s.now.getHours(), rules.rhythmStart, rules.rhythmEnd) && !talkedToday && s.lastRhythmDay !== today) {
    const hour = s.now.getHours();
    const plans = s.laterToday?.length ? `对方今天晚些时候有：${s.laterToday.map(f => `「${f.topic}」`).join('、')}。` : '';
    return {
      kind: 'rhythm',
      reason: `现在是${WEEKDAYS[s.now.getDay()]}${partOfDay(hour)}${hour}点，是对方平时愿意聊天的时候，对方今天还没有和你说过话。${plans}`,
      guide: plans ? '可以就今天的安排说一句。' : '没有具体的事，就只是轻轻打个招呼，和此刻有关，不要编一件事出来。',
    };
  }
  return null;
}
