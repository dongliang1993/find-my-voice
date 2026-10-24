import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../src/shared/protocol.js';
import { latestLine } from '../web/src/features/stage/line.js';

const message = (patch: Partial<ChatMessage> & Pick<ChatMessage, 'role' | 'text'>): ChatMessage => ({
  id: crypto.randomUUID(), kind: 'text', emotion: null, audio: null,
  createdAt: new Date().toISOString(), initiative: null, ...patch,
});

const voice = (id: string, text: string) => message({
  role: 'assistant', kind: 'voice', text,
  audio: { id, state: 'streaming', durationSeconds: null, error: null },
});

test('the audible voice keeps the line even after her follow-up text lands', () => {
  const messages = [message({ role: 'user', text: '说点什么' }), voice('a1', 'Hey, Leo.'), message({ role: 'assistant', text: 'Or tell me.' })];
  assert.equal(latestLine(messages, 'a1')?.text, 'Hey, Leo.');
});

test('the line carries the audio it is read from, so the caption can follow it', () => {
  const messages = [voice('a1', 'Hey, Leo.')];
  assert.equal(latestLine(messages, 'a1')?.audioId, 'a1');
});

test('without anything playing the newest line wins, as before', () => {
  const messages = [message({ role: 'user', text: '说点什么' }), voice('a1', 'Hey, Leo.'), message({ role: 'assistant', text: 'Or tell me.' })];
  assert.equal(latestLine(messages, null)?.text, 'Or tell me.');
});

test('an audible voice is still shown once the user has spoken over it', () => {
  // Interrupting leaves the voice playing; the line must not blank out mid-sentence.
  const messages = [voice('a1', 'Hey, Leo.'), message({ role: 'user', text: '等一下' })];
  assert.equal(latestLine(messages, 'a1')?.text, 'Hey, Leo.');
});

test('nothing said yet is no line', () => {
  assert.equal(latestLine([], null), null);
  assert.equal(latestLine([message({ role: 'user', text: '在吗' })], null), null);
});
