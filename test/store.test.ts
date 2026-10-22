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
