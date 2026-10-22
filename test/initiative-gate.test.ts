import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideCandidate, type InitiativeState, type InitiativeRules } from '../src/server/initiative/gate.js';

const rules: InitiativeRules = {
  enabled: true, quietStart: 23, quietEnd: 8, dailyLimit: 3, cooldownMinutes: 90,
  missYouHours: 30, morningStart: 8, morningEnd: 11,
};

// A Thursday at the given local hour.
const at = (hour: number, minute = 0) => new Date(2026, 9, 22, hour, minute);
const base: InitiativeState = {
  now: at(15), lastUserAt: at(9), lastAssistantAt: at(9), lastInitiativeAt: null,
  initiativesToday: 0, lastMorningDay: null, dueFollowups: [], busy: false,
};

test('nothing happens when nothing is due', () => {
  assert.equal(decideCandidate(rules, base), null);
});

test('a due follow-up becomes a candidate carrying what she remembered', () => {
  const c = decideCandidate(rules, { ...base, dueFollowups: [{ id: 'f1', topic: '周四的面试', note: '他有点紧张' }] });
  assert.equal(c?.kind, 'followup');
  assert.equal(c?.followupId, 'f1');
  assert.match(c!.reason, /周四的面试/);
  assert.match(c!.reason, /紧张/);
});

test('morning greeting only once a day, only in the morning window, only if not talked today', () => {
  const morning = { ...base, now: at(9, 30), lastUserAt: at(1), lastAssistantAt: at(1) };
  assert.equal(decideCandidate(rules, { ...morning, lastUserAt: new Date(2026, 9, 21, 23), lastAssistantAt: new Date(2026, 9, 21, 23) })?.kind, 'morning');
  assert.equal(decideCandidate(rules, { ...morning, lastUserAt: at(9), lastAssistantAt: at(9) }), null, 'already talked this morning');
  assert.equal(decideCandidate(rules, { ...morning, lastUserAt: new Date(2026, 9, 21, 23), lastMorningDay: '2026-10-22' }), null, 'already greeted');
  assert.equal(decideCandidate(rules, { ...base, now: at(14), lastUserAt: new Date(2026, 9, 21, 23) })?.kind ?? null, null, 'not morning anymore');
});

test('misses you after a long silence', () => {
  const c = decideCandidate(rules, { ...base, now: at(20), lastUserAt: new Date(2026, 9, 21, 10), lastAssistantAt: new Date(2026, 9, 21, 10) });
  assert.equal(c?.kind, 'miss_you');
  assert.match(c!.reason, /34/);
});

test('never on a brand-new install with no conversation yet', () => {
  assert.equal(decideCandidate(rules, { ...base, lastUserAt: null, lastAssistantAt: null, now: at(9) }), null);
});

test('quiet hours block everything, including follow-ups, across midnight', () => {
  const yesterday = new Date(2026, 9, 21, 20);
  const due = { ...base, lastUserAt: yesterday, lastAssistantAt: yesterday, dueFollowups: [{ id: 'f1', topic: 'x', note: '' }] };
  assert.equal(decideCandidate(rules, { ...due, now: at(23, 30) }), null);
  assert.equal(decideCandidate(rules, { ...due, now: at(3) }), null);
  assert.equal(decideCandidate(rules, { ...due, now: at(8) })?.kind, 'followup');
});

test('daily limit, cooldown, busy and disabled all block', () => {
  const due = { ...base, dueFollowups: [{ id: 'f1', topic: 'x', note: '' }] };
  assert.equal(decideCandidate(rules, { ...due, initiativesToday: 3 }), null);
  assert.equal(decideCandidate(rules, { ...due, lastInitiativeAt: at(14) }), null, 'within 90 min');
  assert.equal(decideCandidate(rules, { ...due, lastInitiativeAt: at(13) })?.kind, 'followup');
  assert.equal(decideCandidate(rules, { ...due, busy: true }), null);
  assert.equal(decideCandidate({ ...rules, enabled: false }, due), null);
});

test('does not interrupt a live conversation', () => {
  const due = { ...base, dueFollowups: [{ id: 'f1', topic: 'x', note: '' }] };
  assert.equal(decideCandidate(rules, { ...due, lastUserAt: at(14, 55) }), null, 'user spoke 5 minutes ago');
  assert.equal(decideCandidate(rules, { ...due, lastUserAt: at(14, 20) })?.kind, 'followup');
});

test('does not stack messages when she spoke last and got no answer', () => {
  const unanswered = { ...base, now: at(20), lastUserAt: new Date(2026, 9, 21, 10), lastAssistantAt: at(12) };
  assert.equal(decideCandidate(rules, unanswered), null, 'her last message is still unanswered');
  const followupDespite = { ...unanswered, dueFollowups: [{ id: 'f1', topic: '面试', note: '' }] };
  assert.equal(decideCandidate(rules, followupDespite)?.kind, 'followup', 'a remembered date still matters');
});
