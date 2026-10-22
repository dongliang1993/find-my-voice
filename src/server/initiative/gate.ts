// Decides whether there is a reason for her to speak first, right now. Pure and
// clock-injected so every rule is testable. It only proposes; the brain still
// decides whether to actually say anything.

export type InitiativeRules = {
  enabled: boolean;
  /** Local hours; a window that wraps midnight (23 → 8) is fine. */
  quietStart: number;
  quietEnd: number;
  dailyLimit: number;
  cooldownMinutes: number;
  missYouHours: number;
  morningStart: number;
  morningEnd: number;
};

export type DueFollowup = { id: string; topic: string; note: string };

export type InitiativeState = {
  now: Date;
  lastUserAt: Date | null;
  lastAssistantAt: Date | null;
  lastInitiativeAt: Date | null;
  initiativesToday: number;
  /** `YYYY-MM-DD` of the last morning greeting. */
  lastMorningDay: string | null;
  dueFollowups: DueFollowup[];
  /** A reply is in progress. */
  busy: boolean;
};

export type CandidateKind = 'followup' | 'morning' | 'miss_you';
export type Candidate = { kind: CandidateKind; reason: string; followupId?: string };

const HOUR = 3600_000;
/** Leave a live conversation alone: no unprompted message within this long of the user's last word. */
const LIVE_CONVERSATION_MS = 30 * 60_000;

export const localDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

const inWindow = (hour: number, start: number, end: number) =>
  start <= end ? hour >= start && hour < end : hour >= start || hour < end;

function blocked(rules: InitiativeRules, s: InitiativeState) {
  if (!rules.enabled || s.busy) return true;
  // Never on a brand-new install: she has nothing to go on yet.
  if (!s.lastUserAt) return true;
  if (inWindow(s.now.getHours(), rules.quietStart, rules.quietEnd)) return true;
  if (s.initiativesToday >= rules.dailyLimit) return true;
  if (s.lastInitiativeAt && s.now.getTime() - s.lastInitiativeAt.getTime() < rules.cooldownMinutes * 60_000) return true;
  return s.now.getTime() - s.lastUserAt.getTime() < LIVE_CONVERSATION_MS;
}

export function decideCandidate(rules: InitiativeRules, s: InitiativeState): Candidate | null {
  if (blocked(rules, s)) return null;
  const lastUserAt = s.lastUserAt!;

  // Something she promised herself to ask about outranks everything else.
  const followup = s.dueFollowups[0];
  if (followup) {
    return {
      kind: 'followup', followupId: followup.id,
      reason: `你之前记下要关心对方的事到时间了：「${followup.topic}」${followup.note ? `（${followup.note}）` : ''}。`,
    };
  }

  // Don't pile on: if her last message is still unanswered, wait for a reply.
  if (s.lastAssistantAt && s.lastAssistantAt > lastUserAt) return null;

  const today = localDay(s.now);
  const talkedToday = localDay(lastUserAt) === today;
  if (inWindow(s.now.getHours(), rules.morningStart, rules.morningEnd) && !talkedToday && s.lastMorningDay !== today) {
    return { kind: 'morning', reason: '现在是早上，对方今天还没有和你说过话。' };
  }

  const silentHours = (s.now.getTime() - lastUserAt.getTime()) / HOUR;
  if (silentHours >= rules.missYouHours) {
    return { kind: 'miss_you', reason: `对方已经 ${Math.floor(silentHours)} 个小时没有和你说话了。` };
  }
  return null;
}
