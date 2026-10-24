import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideCandidate, FOLLOWUP_WINDOW_MS, type InitiativeState, type InitiativeRules } from '../src/server/initiative/gate.js';

const rules: InitiativeRules = {
  enabled: true, quietStart: 23, quietEnd: 8, dailyLimit: 3, cooldownMinutes: 90,
  rhythmStart: 8, rhythmEnd: 11, echoGapDays: 3,
};

// A Thursday at the given local hour.
const at = (hour: number, minute = 0) => new Date(2026, 9, 22, hour, minute);
const base: InitiativeState = {
  now: at(15), lastUserAt: at(9), lastAssistantAt: at(9), lastInitiativeAt: null,
  initiativesToday: 0, lastRhythmDay: null, dueFollowups: [], busy: false, watching: true,
};
/** Due an hour ago: inside the window, so still worth asking. */
const dueNow = (topic = 'x') => [{ id: 'f1', topic, note: '', dueAt: at(14) }];

test('nothing happens when nothing is due', () => {
  assert.equal(decideCandidate(rules, base), null);
});

test('a due follow-up becomes a candidate carrying what she remembered', () => {
  const c = decideCandidate(rules, { ...base, dueFollowups: [{ id: 'f1', topic: '周四的面试', note: '他有点紧张', dueAt: at(14) }] });
  assert.equal(c?.kind, 'followup');
  assert.equal(c?.followupId, 'f1');
  assert.match(c!.reason, /周四的面试/);
  assert.match(c!.reason, /紧张/);
});

test('morning greeting only once a day, only in the morning window, only if not talked today', () => {
  const morning = { ...base, now: at(9, 30), lastUserAt: at(1), lastAssistantAt: at(1) };
  assert.equal(decideCandidate(rules, { ...morning, lastUserAt: new Date(2026, 9, 21, 23), lastAssistantAt: new Date(2026, 9, 21, 23) })?.kind, 'rhythm');
  assert.equal(decideCandidate(rules, { ...morning, lastUserAt: at(9), lastAssistantAt: at(9) }), null, 'already talked this morning');
  assert.equal(decideCandidate(rules, { ...morning, lastUserAt: new Date(2026, 9, 21, 23), lastRhythmDay: '2026-10-22' }), null, 'already greeted');
  assert.equal(decideCandidate(rules, { ...base, now: at(14), lastUserAt: new Date(2026, 9, 21, 23) })?.kind ?? null, null, 'not morning anymore');
});

test('silence alone is never a reason to speak', () => {
  const silentForDays = { ...base, now: at(20), lastUserAt: new Date(2026, 9, 19, 10), lastAssistantAt: new Date(2026, 9, 19, 10) };
  assert.equal(decideCandidate(rules, silentForDays), null);
  assert.equal(decideCandidate({ ...rules, rhythmStart: null, rhythmEnd: null }, silentForDays), null, 'and not at any other hour either');
});

test('a follow-up whose moment has passed is not asked late', () => {
  const stale = { ...base, dueFollowups: [{ id: 'f1', topic: '面试', note: '', dueAt: new Date(at(15).getTime() - FOLLOWUP_WINDOW_MS - 1) }] };
  assert.equal(decideCandidate(rules, stale), null);
  const fresh = { ...base, dueFollowups: [{ id: 'f1', topic: '面试', note: '', dueAt: new Date(at(15).getTime() - FOLLOWUP_WINDOW_MS + 60_000) }] };
  assert.equal(decideCandidate(rules, fresh)?.kind, 'followup', 'still inside the window');
});

test('never on a brand-new install with no conversation yet', () => {
  assert.equal(decideCandidate(rules, { ...base, lastUserAt: null, lastAssistantAt: null, now: at(9) }), null);
});

test('quiet hours block everything, including follow-ups, across midnight', () => {
  const yesterday = new Date(2026, 9, 21, 20);
  const due = { ...base, lastUserAt: yesterday, lastAssistantAt: yesterday, dueFollowups: dueNow() };
  assert.equal(decideCandidate(rules, { ...due, now: at(23, 30) }), null);
  assert.equal(decideCandidate(rules, { ...due, now: at(3) }), null);
  assert.equal(decideCandidate(rules, { ...due, now: at(8) })?.kind, 'followup');
});

test('daily limit, cooldown, busy and disabled all block', () => {
  const due = { ...base, dueFollowups: dueNow() };
  assert.equal(decideCandidate(rules, { ...due, initiativesToday: 3 }), null);
  assert.equal(decideCandidate(rules, { ...due, lastInitiativeAt: at(14) }), null, 'within 90 min');
  assert.equal(decideCandidate(rules, { ...due, lastInitiativeAt: at(13) })?.kind, 'followup');
  assert.equal(decideCandidate(rules, { ...due, busy: true }), null);
  assert.equal(decideCandidate({ ...rules, enabled: false }, due), null);
});

test('does not interrupt a live conversation', () => {
  const due = { ...base, dueFollowups: dueNow() };
  assert.equal(decideCandidate(rules, { ...due, lastUserAt: at(14, 55) }), null, 'user spoke 5 minutes ago');
  assert.equal(decideCandidate(rules, { ...due, lastUserAt: at(14, 20) })?.kind, 'followup');
});

test('does not stack messages when she spoke last and got no answer', () => {
  const unanswered = { ...base, now: at(20), lastUserAt: new Date(2026, 9, 21, 10), lastAssistantAt: at(12) };
  assert.equal(decideCandidate(rules, unanswered), null, 'her last message is still unanswered');
  const followupDespite = { ...unanswered, dueFollowups: [{ id: 'f1', topic: '面试', note: '', dueAt: at(19) }] };
  assert.equal(decideCandidate(rules, followupDespite)?.kind, 'followup', 'a remembered date still matters');
});

test('she goes quieter when left hanging, and the hour alone stops being enough', () => {
  const morning = { ...base, now: at(9, 30), lastUserAt: new Date(2026, 9, 21, 23), lastAssistantAt: new Date(2026, 9, 21, 23) };
  assert.equal(decideCandidate({ ...rules, followupsOnly: true }, morning), null, 'two unanswered: no greeting');
  assert.equal(decideCandidate({ ...rules, followupsOnly: true }, { ...morning, dueFollowups: dueNow() })?.kind, 'followup', 'but something remembered still gets through');
  assert.equal(decideCandidate({ ...rules, silent: true }, { ...morning, dueFollowups: dueNow() }), null, 'three unanswered: nothing at all');
});

test('waits while a tab is open but hidden', () => {
  const due = { ...base, dueFollowups: dueNow() };
  assert.equal(decideCandidate(rules, { ...due, watching: false }), null, 'a background tab is not a reader');
  assert.equal(decideCandidate(rules, { ...due, watching: true })?.kind, 'followup');
});

test('still speaks with no page open at all, the OS notification carries it', () => {
  const due = { ...base, dueFollowups: dueNow() };
  assert.equal(decideCandidate(rules, { ...due, watching: null })?.kind, 'followup');
});

// ---- echo: a line that stayed with her ----

const yesterday = (hour: number) => new Date(2026, 9, 21, hour);
const held = (saidAt = yesterday(21)) => [{ id: 'e1', line: '那片橙色的天', note: '他说像被点着了', saidAt }];
/** Someone she knows, who answered her last time, and nothing with a date on it. */
const familiar = { ...base, now: at(15), daysTalked: 6, lastUserAt: at(9), lastAssistantAt: at(9) };

test('a line that stayed with her becomes an echo, quoting the user', () => {
  const c = decideCandidate(rules, { ...familiar, echoes: held() });
  assert.equal(c?.kind, 'echo');
  assert.equal(c?.echoId, 'e1');
  assert.match(c!.reason, /昨天/);
  assert.match(c!.reason, /「那片橙色的天」/);
  assert.match(c!.guide!, /不要变成提问/);
});

test('an echo waits until you know each other', () => {
  assert.equal(decideCandidate(rules, { ...familiar, daysTalked: 2, echoes: held() }), null, 'two days in: only dated things');
  assert.equal(decideCandidate(rules, { ...familiar, daysTalked: 5, echoes: held() })?.kind, 'echo');
});

test('an echo cannot come back the same evening, and fades after two days', () => {
  assert.equal(decideCandidate(rules, { ...familiar, echoes: held(at(13)) }), null, 'two hours ago is still the same conversation');
  assert.equal(decideCandidate(rules, { ...familiar, echoes: held(new Date(2026, 9, 20, 9)) }), null, 'three days ago has faded');
});

test('echoes are rare: one every few days', () => {
  assert.equal(decideCandidate(rules, { ...familiar, echoes: held(), lastEchoAt: at(15 - 48) }), null, 'two days since the last one, gap is three');
  assert.equal(decideCandidate(rules, { ...familiar, echoes: held(), lastEchoAt: new Date(2026, 9, 18, 15) })?.kind, 'echo');
  assert.equal(decideCandidate({ ...rules, echoGapDays: null }, { ...familiar, echoes: held() }), null, 'a mode without echoes');
});

test('something with a date on it still comes first', () => {
  assert.equal(decideCandidate(rules, { ...familiar, echoes: held(), dueFollowups: dueNow() })?.kind, 'followup');
});

test('an echo is hers, not theirs: it never gets through when she has been left hanging', () => {
  assert.equal(decideCandidate({ ...rules, followupsOnly: true }, { ...familiar, echoes: held() }), null);
  assert.equal(decideCandidate(rules, { ...familiar, echoes: held(), lastAssistantAt: at(10) }), null, 'her last message is unanswered');
});

// ---- rhythm: the hour they like company ----

test('the greeting names the hour it actually falls in, not always morning', () => {
  const evening = { ...base, now: at(18, 30), lastUserAt: yesterday(22), lastAssistantAt: yesterday(22) };
  const c = decideCandidate({ ...rules, rhythmStart: 17, rhythmEnd: 20 }, evening);
  assert.equal(c?.kind, 'rhythm');
  assert.match(c!.reason, /周四傍晚18点/);
  assert.doesNotMatch(c!.reason, /早上/);
});

test('a greeting hangs on what the user has later today, when there is something', () => {
  const morning = { ...base, now: at(9, 30), lastUserAt: yesterday(22), lastAssistantAt: yesterday(22) };
  const plain = decideCandidate(rules, morning);
  assert.match(plain!.guide!, /不要编一件事出来/, 'nothing today: a plain greeting, nothing invented');
  const withPlans = decideCandidate(rules, { ...morning, laterToday: [{ id: 'f2', topic: '下午的面试', note: '', dueAt: at(16) }] });
  assert.match(withPlans!.reason, /「下午的面试」/);
  assert.match(withPlans!.guide!, /今天的安排/);
});
