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

// ---- letters ----

test('a letter is written, finished, opened once, and listed newest first', () => {
  let now = new Date(2026, 9, 24, 11, 20);
  const s = new ChatStore(mkdtempSync(join(tmpdir(), 'fmv-store-')), () => now);
  const first = s.createLetter({ signature: 'Vivi' });
  assert.equal(first.status, 'writing');
  assert.equal(first.openedAt, null);
  s.writeLetter(first.id, { title: '下雨天', blocks: [{ id: 'b1', type: 'heading', text: '电影' }], status: 'done' });
  now = new Date(2026, 9, 24, 12, 0);
  const second = s.createLetter({ signature: 'Vivi' });

  assert.deepEqual(s.letters().map(l => l.id), [second.id, first.id]);
  now = new Date(2026, 9, 24, 12, 5);
  const opened = s.openLetter(first.id)!;
  now = new Date(2026, 9, 24, 13, 0);
  assert.equal(s.openLetter(first.id)!.openedAt, opened.openedAt, 'the first opening is the one kept');
  assert.equal(s.letter(first.id)?.title, '下雨天');
});

test('an edit is a new version, and the old blocks are kept as history', () => {
  const s = store();
  const letter = s.createLetter({ signature: 'Vivi' });
  s.writeLetter(letter.id, { title: 't', blocks: [{ id: 'b1', type: 'heading', text: '旧' }], status: 'done' });
  const revised = s.reviseLetter(letter.id, [{ id: 'b1', type: 'heading', text: '新' }]);
  assert.equal(revised.version, 2);
  assert.equal(revised.blocks[0]?.type === 'heading' && revised.blocks[0].text, '新');
  const [old] = s.letterHistory(letter.id);
  assert.equal(old?.version, 1);
  assert.equal(old?.blocks[0]?.type === 'heading' && old.blocks[0].text, '旧');
});

test('a deleted letter leaves the inbox; a letter message keeps pointing at it', () => {
  const s = store();
  const letter = s.createLetter({ signature: 'Vivi' });
  const message = s.append({ role: 'assistant', kind: 'letter', text: '（写了一封信「t」）', letterId: letter.id });
  s.linkLetter(letter.id, message.id);
  assert.equal(s.recent().at(-1)?.letterId, letter.id);
  assert.equal(s.letterMessageId(letter.id), message.id);
  assert.ok(s.deleteLetter(letter.id));
  assert.equal(s.letter(letter.id), null);
  assert.equal(s.letters().length, 0);
  assert.equal(s.deleteLetter(letter.id), false, 'already gone');
});

test('a letter still being written when the process died comes back broken, with what it had', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fmv-store-'));
  const before = new ChatStore(dir);
  const letter = before.createLetter({ signature: 'Vivi' });
  before.writeLetter(letter.id, { title: '半封', blocks: [{ id: 'b1', type: 'heading', text: '电影' }] });
  const after = new ChatStore(dir);
  assert.equal(after.letter(letter.id)?.status, 'broken');
  assert.equal(after.letter(letter.id)?.blocks.length, 1);
});
