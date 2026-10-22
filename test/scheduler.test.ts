import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatStore } from '../src/server/chat/store.js';
import { InitiativeScheduler } from '../src/server/initiative/scheduler.js';
import type { InitiativeRules } from '../src/server/initiative/gate.js';
import type { SpeakUpOutcome, SpeakUpRequest } from '../src/server/chat/service.js';
import type { ChatMessage } from '../src/shared/protocol.js';

const rules: InitiativeRules = {
  enabled: true, quietStart: 23, quietEnd: 8, dailyLimit: 3, cooldownMinutes: 90,
  missYouHours: 30, morningStart: 8, morningEnd: 11,
};

function setup({ outcome = 'spoke' as SpeakUpOutcome, busy = false, extract = async (): Promise<unknown> => 'nothing_new' } = {}) {
  const store = new ChatStore(mkdtempSync(join(tmpdir(), 'fmv-sched-')));
  let now = new Date(2026, 9, 22, 15, 0);
  const asked: SpeakUpRequest[] = [];
  const notified: string[] = [];
  let extractions = 0;
  const scheduler = new InitiativeScheduler({
    store, rules: () => rules, now: () => now,
    chat: { get busy() { return busy; }, speakUp: async r => {
      asked.push(r);
      const messages: ChatMessage[] = outcome === 'spoke' ? [store.append({ role: 'assistant', kind: 'text', text: '嗨', initiative: r.kind })] : [];
      return { outcome, messages };
    } },
    memory: { run: async () => { extractions++; return extract(); } },
    notify: text => { notified.push(text); },
  });
  return { store, scheduler, asked, notified, advance: (ms: number) => { now = new Date(now.getTime() + ms); }, setNow: (d: Date) => { now = d; }, extractions: () => extractions };
}

const MIN = 60_000;

test('leaves a live conversation alone even with a follow-up due', async () => {
  const s = setup({ outcome: 'spoke' });
  s.store.append({ role: 'user', kind: 'text', text: '后天面试' });
  s.store.addFollowup({ topic: '面试', note: '', dueAt: new Date(Date.now() - MIN) });
  s.setNow(new Date(Date.now() + 5 * MIN));
  await s.scheduler.tick();
  assert.equal(s.asked.length, 0, 'the user spoke five minutes ago');
});

test('speaks up for a due follow-up after a quiet spell, and does not repeat it', async () => {
  const s = setup({ outcome: 'passed' });
  s.store.append({ role: 'user', kind: 'text', text: '后天面试' });
  s.store.addFollowup({ topic: '面试', note: '紧张', dueAt: new Date(Date.now() - MIN) });
  s.setNow(new Date(Date.now() + 2 * 3600_000));
  await s.scheduler.tick();
  assert.equal(s.asked.length, 1);
  assert.equal(s.asked[0]?.kind, 'followup');
  await s.scheduler.tick();
  assert.equal(s.asked.length, 1, 'resolved even though she passed');
});

test('notifies only when she actually said something', async () => {
  const spoke = setup({ outcome: 'spoke' });
  spoke.store.append({ role: 'user', kind: 'text', text: 'x' });
  spoke.store.addFollowup({ topic: '面试', note: '', dueAt: new Date(Date.now() - MIN) });
  spoke.setNow(new Date(Date.now() + 2 * 3600_000));
  await spoke.scheduler.tick();
  assert.deepEqual(spoke.notified, ['嗨']);

  const passed = setup({ outcome: 'passed' });
  passed.store.append({ role: 'user', kind: 'text', text: 'x' });
  passed.store.addFollowup({ topic: '面试', note: '', dueAt: new Date(Date.now() - MIN) });
  passed.setNow(new Date(Date.now() + 2 * 3600_000));
  await passed.scheduler.tick();
  assert.deepEqual(passed.notified, []);
});

test('a failed speak-up leaves the follow-up for a later try', async () => {
  const s = setup({ outcome: 'failed' });
  s.store.append({ role: 'user', kind: 'text', text: 'x' });
  s.store.addFollowup({ topic: '面试', note: '', dueAt: new Date(Date.now() - MIN) });
  s.setNow(new Date(Date.now() + 2 * 3600_000));
  await s.scheduler.tick();
  assert.equal(s.store.dueFollowups(new Date(Date.now() + 3 * 3600_000)).length, 1);
});

test('stays out of the way while a reply is in progress', async () => {
  const s = setup({ busy: true });
  s.store.append({ role: 'user', kind: 'text', text: 'x' });
  s.store.addFollowup({ topic: '面试', note: '', dueAt: new Date(Date.now() - MIN) });
  s.setNow(new Date(Date.now() + 2 * 3600_000));
  await s.scheduler.tick();
  assert.equal(s.asked.length, 0);
});

test('extracts memory once the conversation has gone quiet, not mid-chat', async () => {
  const s = setup();
  s.store.append({ role: 'user', kind: 'text', text: 'x' });
  s.setNow(new Date(Date.now() + 2 * MIN));
  await s.scheduler.tick();
  assert.equal(s.extractions(), 0, 'still chatting');
  s.setNow(new Date(Date.now() + 15 * MIN));
  await s.scheduler.tick();
  assert.equal(s.extractions(), 1);
});

test('overlapping ticks never run twice at once', async () => {
  let release!: () => void;
  const s = setup({ extract: () => new Promise(r => { release = () => r('nothing_new'); }) as Promise<'nothing_new'> });
  s.store.append({ role: 'user', kind: 'text', text: 'x' });
  s.setNow(new Date(Date.now() + 15 * MIN));
  const first = s.scheduler.tick();
  const second = s.scheduler.tick();
  assert.equal(first, second, 'the overlapping call joins the pass in progress');
  await new Promise(r => setTimeout(r, 10));
  release();
  await first;
  assert.equal(s.extractions(), 1);
});

test('a morning greeting marks the day, so a second tick does not greet again', async () => {
  const s = setup({ outcome: 'spoke' });
  s.store.append({ role: 'user', kind: 'text', text: 'x' });
  const tomorrowMorning = new Date(); tomorrowMorning.setDate(tomorrowMorning.getDate() + 1); tomorrowMorning.setHours(9, 0, 0, 0);
  s.setNow(tomorrowMorning);
  await s.scheduler.tick();
  assert.equal(s.asked[0]?.kind, 'morning');
  s.setNow(new Date(tomorrowMorning.getTime() + 2 * 3600_000));
  await s.scheduler.tick();
  assert.notEqual(s.asked[1]?.kind, 'morning');
});

test('after she declines a missed-you nudge, she is not asked again until the user speaks', async () => {
  const s = setup({ outcome: 'passed' });
  s.store.append({ role: 'user', kind: 'text', text: 'x' });
  s.setNow(new Date(Date.now() + 40 * 3600_000));
  await s.scheduler.tick();
  assert.equal(s.asked[0]?.kind, 'miss_you');
  s.setNow(new Date(Date.now() + 41 * 3600_000));
  await s.scheduler.tick();
  assert.equal(s.asked.length, 1, 'declined once: wait for the user, do not re-ask every minute');
});

test('failures back off instead of calling the model every minute', async () => {
  const s = setup({ outcome: 'failed' });
  s.store.append({ role: 'user', kind: 'text', text: 'x' });
  s.store.addFollowup({ topic: '面试', note: '', dueAt: new Date(Date.now() - MIN) });
  const t0 = Date.now() + 2 * 3600_000;
  s.setNow(new Date(t0));
  await s.scheduler.tick();
  s.setNow(new Date(t0 + MIN));
  await s.scheduler.tick();
  assert.equal(s.asked.length, 1, 'no retry a minute later');
  s.setNow(new Date(t0 + 31 * MIN));
  await s.scheduler.tick();
  assert.equal(s.asked.length, 2, 'retried after the backoff');
});

test('a failing memory extraction backs off too', async () => {
  let calls = 0;
  const s = setup({ extract: async () => { calls++; throw new Error('model down'); } });
  s.store.append({ role: 'user', kind: 'text', text: 'x' });
  const t0 = Date.now() + 15 * MIN;
  s.setNow(new Date(t0));
  await s.scheduler.tick();
  s.setNow(new Date(t0 + MIN));
  await s.scheduler.tick();
  assert.equal(calls, 1);
});
