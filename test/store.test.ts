import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatStore } from '../src/server/chat/store.js';

const store = () => new ChatStore(mkdtempSync(join(tmpdir(), 'fmv-store-')));

test('appends messages and lists them in order', () => {
  const s = store();
  const a = s.append({ role: 'user', kind: 'text', text: '在吗' });
  const b = s.append({ role: 'assistant', kind: 'text', text: '在呀' });
  assert.deepEqual(s.recent().map(m => m.id), [a.id, b.id]);
  assert.equal(a.audio, null);
});

test('recent returns the newest N in chronological order', () => {
  const s = store();
  for (let i = 0; i < 5; i++) s.append({ role: 'user', kind: 'text', text: String(i) });
  assert.deepEqual(s.recent(2).map(m => m.text), ['3', '4']);
});

test('update returns a new message and persists it', () => {
  const s = store();
  const m = s.append({ role: 'assistant', kind: 'text', text: '' });
  const next = s.update(m.id, { text: '你好呀' });
  assert.equal(next.text, '你好呀');
  assert.equal(m.text, '');
  assert.equal(s.get(m.id)?.text, '你好呀');
});

test('voice messages carry audio state through updates', () => {
  const s = store();
  const m = s.append({ role: 'assistant', kind: 'voice', text: '晚安', emotion: '温柔',
    audio: { id: 'a1', state: 'streaming', durationSeconds: null, error: null } });
  s.update(m.id, { audio: { id: 'a1', state: 'ready', durationSeconds: 1.5, error: null } });
  const saved = s.get(m.id)!;
  assert.equal(saved.emotion, '温柔');
  assert.deepEqual(saved.audio, { id: 'a1', state: 'ready', durationSeconds: 1.5, error: null });
});

test('marks voice still streaming at startup as failed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fmv-store-'));
  const first = new ChatStore(dir);
  const m = first.append({ role: 'assistant', kind: 'voice', text: 'x', audio: { id: 'a', state: 'streaming', durationSeconds: null, error: null } });
  first.close();
  const reopened = new ChatStore(dir);
  assert.equal(reopened.get(m.id)?.audio?.state, 'failed');
});

test('remembers the brain session id', () => {
  const s = store();
  assert.equal(s.getState('brain_session'), null);
  s.setState('brain_session', 'abc');
  assert.equal(s.getState('brain_session'), 'abc');
});

test('update of an unknown id throws', () => {
  assert.throws(() => store().update('nope', { text: 'x' }), /not found/i);
});

test('reports when each side last spoke', () => {
  const s = store();
  assert.deepEqual(s.lastSpoke(), { user: null, assistant: null });
  const u = s.append({ role: 'user', kind: 'text', text: 'hi' });
  const a = s.append({ role: 'assistant', kind: 'voice', text: 'yo' });
  const last = s.lastSpoke();
  assert.equal(last.user?.toISOString(), u.createdAt);
  assert.equal(last.assistant?.toISOString(), a.createdAt);
});

test('initiative messages are marked and counted per day', () => {
  const s = store();
  s.append({ role: 'assistant', kind: 'text', text: '早', initiative: 'rhythm' });
  s.append({ role: 'assistant', kind: 'text', text: '普通回复' });
  assert.equal(s.recent().find(m => m.text === '早')?.initiative, 'rhythm');
  assert.equal(s.recent().find(m => m.text === '普通回复')?.initiative, null);
  assert.equal(s.initiativesSince(new Date(Date.now() - 60_000)), 1);
  assert.equal(s.initiativesSince(new Date(Date.now() + 60_000)), 0);
  assert.ok(s.lastInitiativeAt());
});

test('follow-ups: due ones come back oldest first, and are not repeated once done', () => {
  const s = store();
  const now = new Date('2026-10-22T12:00:00Z');
  s.addFollowup({ topic: '面试', note: '有点紧张', dueAt: new Date('2026-10-22T10:00:00Z') });
  s.addFollowup({ topic: '体检结果', note: '', dueAt: new Date('2026-10-22T09:00:00Z') });
  s.addFollowup({ topic: '下周的旅行', note: '', dueAt: new Date('2026-10-29T09:00:00Z') });
  const due = s.dueFollowups(now);
  assert.deepEqual(due.map(f => f.topic), ['体检结果', '面试']);
  s.resolveFollowup(due[0]!.id);
  assert.deepEqual(s.dueFollowups(now).map(f => f.topic), ['面试']);
});

test('follow-ups with the same topic and day are not stored twice', () => {
  const s = store();
  const dueAt = new Date('2026-10-22T10:00:00Z');
  assert.equal(s.addFollowup({ topic: '面试', note: '', dueAt }), true);
  assert.equal(s.addFollowup({ topic: '面试', note: '再说一次', dueAt }), false);
  assert.equal(s.dueFollowups(new Date('2026-10-23T00:00:00Z')).length, 1);
});

test('messages after a point are listed for memory extraction', () => {
  const s = store();
  const a = s.append({ role: 'user', kind: 'text', text: 'a' });
  s.append({ role: 'assistant', kind: 'text', text: 'b' });
  s.append({ role: 'user', kind: 'text', text: 'c' });
  assert.deepEqual(s.after(null).map(m => m.text), ['a', 'b', 'c']);
  assert.deepEqual(s.after(a.id).map(m => m.text), ['b', 'c']);
});

test('a cursor pointing at a vanished message starts over instead of reading nothing forever', () => {
  const s = store();
  s.append({ role: 'user', kind: 'text', text: 'a' });
  assert.deepEqual(s.after('gone-id').map(m => m.text), ['a']);
});

test('greetings stored as "morning" read back as "rhythm" after an upgrade', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fmv-store-'));
  const before = new ChatStore(dir);
  // What an older version wrote, before the greeting could fall at any hour.
  before.append({ role: 'assistant', kind: 'text', text: '早', initiative: 'morning' as never });
  const after = new ChatStore(dir);
  assert.equal(after.recent()[0]?.initiative, 'rhythm');
});

test('days talked counts distinct days the user spoke, not messages or her turns', () => {
  let now = new Date(2026, 9, 20, 10);
  const s = new ChatStore(mkdtempSync(join(tmpdir(), 'fmv-store-')), () => now);
  s.append({ role: 'user', kind: 'text', text: 'a' });
  s.append({ role: 'user', kind: 'text', text: 'b' });
  now = new Date(2026, 9, 21, 10);
  s.append({ role: 'assistant', kind: 'text', text: '她自己说的', initiative: 'rhythm' });
  now = new Date(2026, 9, 22, 23);
  s.append({ role: 'user', kind: 'text', text: 'c' });
  assert.equal(s.daysTalked(), 2);
});
