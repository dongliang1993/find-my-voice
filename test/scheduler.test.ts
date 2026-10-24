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
  rhythmStart: 8, rhythmEnd: 11, echoGapDays: 3,
};

function setup({ outcome = 'spoke' as SpeakUpOutcome, busy = false, extract = async (): Promise<unknown> => 'nothing_new', judge }: {
  outcome?: SpeakUpOutcome;
  busy?: boolean;
  extract?: () => Promise<unknown>;
  judge?: (candidate: { kind: string; reason: string }, recent: ChatMessage[]) => Promise<{ speak: boolean; subject: string; reason: string }>;
} = {}) {
  // The store shares the scheduler's fake clock, so a test's "later" is later
  // than its own rows; with the real clock, every test after ~17:00 local
  // saw rows stamped in the "future" and silently turned into no-ops.
  let now = new Date(2026, 9, 22, 15, 0);
  const store = new ChatStore(mkdtempSync(join(tmpdir(), 'fmv-sched-')), () => now);
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
    judge,
    notify: text => { notified.push(text); },
  });
  return { store, scheduler, asked, notified, advance: (ms: number) => { now = new Date(now.getTime() + ms); }, setNow: (d: Date) => { now = d; }, extractions: () => extractions };
}

const MIN = 60_000;

test('leaves a live conversation alone even with a follow-up due', async () => {
  const s = setup({ outcome: 'spoke' });
  s.store.append({ role: 'user', kind: 'text', text: '后天面试' });
  s.store.addFollowup({ topic: '面试', note: '', dueAt: new Date(2026, 9, 22, 14, 0) });
  s.advance(5 * MIN);
  await s.scheduler.tick();
  assert.equal(s.asked.length, 0, 'the user spoke five minutes ago');
});

test('speaks up for a due follow-up after a quiet spell, and does not repeat it', async () => {
  const s = setup({ outcome: 'passed' });
  s.store.append({ role: 'user', kind: 'text', text: '后天面试' });
  s.store.addFollowup({ topic: '面试', note: '紧张', dueAt: new Date(2026, 9, 22, 14, 0) });
  s.advance(2 * 3600_000);
  await s.scheduler.tick();
  assert.equal(s.asked.length, 1);
  assert.equal(s.asked[0]?.kind, 'followup');
  await s.scheduler.tick();
  assert.equal(s.asked.length, 1, 'resolved even though she passed');
});

test('notifies only when she actually said something', async () => {
  const spoke = setup({ outcome: 'spoke' });
  spoke.store.append({ role: 'user', kind: 'text', text: 'x' });
  spoke.store.addFollowup({ topic: '面试', note: '', dueAt: new Date(2026, 9, 22, 14, 0) });
  spoke.advance(2 * 3600_000);
  await spoke.scheduler.tick();
  assert.deepEqual(spoke.notified, ['嗨']);

  const passed = setup({ outcome: 'passed' });
  passed.store.append({ role: 'user', kind: 'text', text: 'x' });
  passed.store.addFollowup({ topic: '面试', note: '', dueAt: new Date(2026, 9, 22, 14, 0) });
  passed.advance(2 * 3600_000);
  await passed.scheduler.tick();
  assert.deepEqual(passed.notified, []);
});

test('a failed speak-up leaves the follow-up for a later try', async () => {
  const s = setup({ outcome: 'failed' });
  s.store.append({ role: 'user', kind: 'text', text: 'x' });
  s.store.addFollowup({ topic: '面试', note: '', dueAt: new Date(2026, 9, 22, 14, 0) });
  s.advance(2 * 3600_000);
  await s.scheduler.tick();
  assert.equal(s.store.dueFollowups(new Date(2026, 9, 22, 23)).length, 1);
});

test('stays out of the way while a reply is in progress', async () => {
  const s = setup({ busy: true });
  s.store.append({ role: 'user', kind: 'text', text: 'x' });
  s.store.addFollowup({ topic: '面试', note: '', dueAt: new Date(2026, 9, 22, 14, 0) });
  s.advance(2 * 3600_000);
  await s.scheduler.tick();
  assert.equal(s.asked.length, 0);
});

test('extracts memory once the conversation has gone quiet, not mid-chat', async () => {
  const s = setup();
  s.store.append({ role: 'user', kind: 'text', text: 'x' });
  s.advance(2 * MIN);
  await s.scheduler.tick();
  assert.equal(s.extractions(), 0, 'still chatting');
  s.advance(15 * MIN);
  await s.scheduler.tick();
  assert.equal(s.extractions(), 1);
});

test('overlapping ticks never run twice at once', async () => {
  let release!: () => void;
  const s = setup({ extract: () => new Promise(r => { release = () => r('nothing_new'); }) as Promise<'nothing_new'> });
  s.store.append({ role: 'user', kind: 'text', text: 'x' });
  s.advance(15 * MIN);
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
  assert.equal(s.asked[0]?.kind, 'rhythm');
  s.setNow(new Date(tomorrowMorning.getTime() + 2 * 3600_000));
  await s.scheduler.tick();
  assert.notEqual(s.asked[1]?.kind, 'rhythm');
});

test('silence on its own never makes her speak, however long it lasts', async () => {
  const s = setup({ outcome: 'spoke' });
  s.store.append({ role: 'user', kind: 'text', text: 'x' });
  s.setNow(new Date(2026, 9, 29, 19, 0));
  await s.scheduler.tick();
  assert.equal(s.asked.length, 0, 'no reason, no opening');
});

test('failures back off instead of calling the model every minute', async () => {
  const s = setup({ outcome: 'failed' });
  s.store.append({ role: 'user', kind: 'text', text: 'x' });
  s.store.addFollowup({ topic: '面试', note: '', dueAt: new Date(2026, 9, 22, 14, 0) });
  const t0 = 2 * 3600_000;
  s.advance(t0);
  await s.scheduler.tick();
  s.advance(MIN);
  await s.scheduler.tick();
  assert.equal(s.asked.length, 1, 'no retry a minute later');
  s.advance(30 * MIN);
  await s.scheduler.tick();
  assert.equal(s.asked.length, 2, 'retried after the backoff');
});

test('a failing memory extraction backs off too', async () => {
  let calls = 0;
  const s = setup({ extract: async () => { calls++; throw new Error('model down'); } });
  s.store.append({ role: 'user', kind: 'text', text: 'x' });
  const t0 = 15 * MIN;
  s.advance(t0);
  await s.scheduler.tick();
  s.advance(MIN);
  await s.scheduler.tick();
  assert.equal(calls, 1);
});

test('the judge can stop an opening the clock allowed', async () => {
  const s = setup({ outcome: 'spoke', judge: async () => ({ speak: false, subject: '', reason: '刚道过别' }) });
  s.store.append({ role: 'user', kind: 'text', text: 'x' });
  s.store.addFollowup({ topic: '面试', note: '', dueAt: new Date(2026, 9, 22, 14, 0) });
  s.advance(2 * 3600_000);
  await s.scheduler.tick();
  assert.equal(s.asked.length, 0, 'the persona is never asked');
});

test('a "not now" is not re-asked every minute', async () => {
  let calls = 0;
  const s = setup({ outcome: 'spoke', judge: async () => { calls++; return { speak: false, subject: '', reason: '忙' }; } });
  s.store.append({ role: 'user', kind: 'text', text: 'x' });
  s.store.addFollowup({ topic: '面试', note: '', dueAt: new Date(2026, 9, 22, 14, 0) });
  s.advance(2 * 3600_000);
  await s.scheduler.tick();
  s.advance(MIN);
  await s.scheduler.tick();
  assert.equal(calls, 1, 'waits out the backoff');
  s.advance(30 * MIN);
  await s.scheduler.tick();
  assert.equal(calls, 2);
});

test('the subject the judge settled on reaches the persona', async () => {
  const s = setup({ outcome: 'spoke', judge: async () => ({ speak: true, subject: '问面试结果', reason: '到时间了' }) });
  s.store.append({ role: 'user', kind: 'text', text: 'x' });
  s.store.addFollowup({ topic: '面试', note: '', dueAt: new Date(2026, 9, 22, 14, 0) });
  s.advance(2 * 3600_000);
  await s.scheduler.tick();
  assert.match(s.asked[0]!.reason, /问面试结果/);
});

test('unanswered openings are counted, and one reply resets them', async () => {
  const s = setup({ outcome: 'spoke' });
  s.store.append({ role: 'user', kind: 'text', text: 'x' });
  assert.equal(s.store.unansweredInitiatives(), 0);
  s.store.append({ role: 'assistant', kind: 'text', text: '嗨', initiative: 'followup' });
  assert.equal(s.store.unansweredInitiatives(), 1, 'one opening');
  s.store.append({ role: 'assistant', kind: 'text', text: '算了', initiative: 'rhythm' });
  assert.equal(s.store.unansweredInitiatives(), 2, 'a second opening since the user spoke');
  s.store.append({ role: 'user', kind: 'text', text: '在的' });
  assert.equal(s.store.unansweredInitiatives(), 0, 'showing up is the signal');
});

test('an echo is offered once: spoken or not, it does not come back', async () => {
  const s = setup({ outcome: 'passed' });
  // Five different days of talking, so she knows the user well enough for an echo.
  for (let day = 16; day <= 20; day++) {
    s.setNow(new Date(2026, 9, day, 20, 0));
    s.store.append({ role: 'user', kind: 'text', text: `第${day}天` });
  }
  s.setNow(new Date(2026, 9, 21, 21, 0));
  const said = s.store.append({ role: 'user', kind: 'text', text: '那片橙色的天' });
  s.store.addEcho({ line: '那片橙色的天', note: '', saidAt: new Date(said.createdAt) });
  s.setNow(new Date(2026, 9, 22, 15, 0));
  await s.scheduler.tick();
  assert.equal(s.asked[0]?.kind, 'echo');
  assert.match(s.asked[0]!.reason, /那片橙色的天/);
  assert.match(s.asked[0]!.reason, /不要变成提问/, 'the persona gets the guide');
  s.advance(3 * 3600_000);
  await s.scheduler.tick();
  assert.equal(s.asked.filter(r => r.kind === 'echo').length, 1);
});

test('an echo the judge turns down is let go, not re-asked', async () => {
  let calls = 0;
  const s = setup({ outcome: 'spoke', judge: async () => { calls++; return { speak: false, subject: '', reason: '太私人' }; } });
  for (let day = 16; day <= 21; day++) {
    s.setNow(new Date(2026, 9, day, 20, 0));
    s.store.append({ role: 'user', kind: 'text', text: `第${day}天` });
  }
  s.store.addEcho({ line: '第21天', note: '', saidAt: new Date(2026, 9, 21, 20, 0) });
  s.setNow(new Date(2026, 9, 22, 15, 0));
  await s.scheduler.tick();
  s.advance(31 * MIN);
  await s.scheduler.tick();
  assert.equal(calls, 1, 'the second tick has nothing left to ask about');
  assert.equal(s.store.echoes(new Date(0), new Date('2100-01-01')).length, 0);
});

test('the greeting carries what the user has later today', async () => {
  const s = setup({ outcome: 'spoke' });
  s.store.append({ role: 'user', kind: 'text', text: 'x' });
  const morning = new Date(2026, 9, 23, 9, 0);
  s.store.addFollowup({ topic: '下午的面试', note: '', dueAt: new Date(2026, 9, 23, 18, 0) });
  s.setNow(morning);
  await s.scheduler.tick();
  assert.equal(s.asked[0]?.kind, 'rhythm');
  assert.match(s.asked[0]!.reason, /下午的面试/);
});

test('down fast, up slow: each unanswered opening steps her back, each day you come back steps her forward one', async () => {
  let now = new Date(2026, 9, 22, 15, 0);
  const store = new ChatStore(mkdtempSync(join(tmpdir(), 'fmv-sched-')), () => now);
  const seen: number[] = [];
  const scheduler = new InitiativeScheduler({
    store, now: () => now,
    rules: adapt => { seen.push(adapt?.unanswered ?? 0); return { ...rules, enabled: false }; },
    chat: { busy: false, speakUp: async () => ({ outcome: 'passed', messages: [] }) },
    memory: { run: async () => 'nothing_new' },
  });
  const level = async () => { await scheduler.tick(); return seen.at(-1); };

  store.append({ role: 'user', kind: 'text', text: 'x' });
  for (let i = 0; i < 3; i++) store.append({ role: 'assistant', kind: 'text', text: `开口${i}`, initiative: 'followup' });
  assert.equal(await level(), 3, 'three openings left hanging');

  now = new Date(2026, 9, 23, 10, 0);
  store.append({ role: 'user', kind: 'text', text: '我回来了' });
  assert.equal(await level(), 2, 'one day back: one step');
  now = new Date(2026, 9, 23, 11, 0);
  store.append({ role: 'user', kind: 'text', text: '还在聊' });
  assert.equal(await level(), 2, 'more of the same day is not another step');

  now = new Date(2026, 9, 24, 10, 0);
  store.append({ role: 'user', kind: 'text', text: '第二天' });
  assert.equal(await level(), 1, 'a second day: another step');
});
