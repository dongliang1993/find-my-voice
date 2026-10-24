import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CUE_MAX_MS, envelopeDue, type CueInput } from '../web/src/features/letter/cue.js';
import type { ChatMessage } from '../src/shared/protocol.js';

const at = Date.parse('2026-10-24T11:20:00Z');
const voice = (state: 'streaming' | 'ready' | 'failed'): ChatMessage => ({
  id: 'v', role: 'assistant', kind: 'voice', text: '我挑了几部，写给你了。', emotion: null, createdAt: '', initiative: null,
  audio: { id: 'a1', state, durationSeconds: null, error: null },
});
const card: ChatMessage = { id: 'c', role: 'assistant', kind: 'letter', text: '', emotion: null, audio: null, createdAt: '', initiative: null, letterId: 'L1' };
const base: CueInput = {
  letter: { id: 'L1', createdAt: new Date(at).toISOString() },
  messages: [voice('streaming'), card], playing: null, heard: null, lines: {}, now: at + 1000,
};

test('typed or silent: the envelope comes at once', () => {
  const typed: ChatMessage = { ...voice('ready'), kind: 'text', audio: null };
  assert.equal(envelopeDue({ ...base, messages: [typed, card] }), true);
  assert.equal(envelopeDue({ ...base, messages: [card] }), true);
  assert.equal(envelopeDue({ ...base, messages: [voice('failed'), card] }), true);
});

test('her voice not audible yet: it waits', () => {
  assert.equal(envelopeDue(base), false);
  assert.equal(envelopeDue({ ...base, playing: 'other' }), false, 'an earlier line is still playing');
});

test('it comes as she starts saying she wrote it', () => {
  const lines = { a1: [{ text: '下雨的周六，适合慢一点的东西。', startsAt: 0 }, { text: '我挑了几部，写给你了。', startsAt: 2.4 }] };
  const playing = { ...base, playing: 'a1', lines };
  assert.equal(envelopeDue({ ...playing, heard: 1 }), false, 'still on the first sentence');
  assert.equal(envelopeDue({ ...playing, heard: 2.5 }), true, 'the handing-over sentence has started');
});

test('while more may still follow, an ordinary last sentence is not the cue', () => {
  const lines = { a1: [{ text: '下雨的周六，适合慢一点的东西。', startsAt: 0 }] };
  assert.equal(envelopeDue({ ...base, playing: 'a1', lines, heard: 0.5 }), false);
  assert.equal(envelopeDue({ ...base, messages: [voice('ready'), card], playing: 'a1', lines, heard: 0.5 }), true, 'all of it is known: the last one is the last');
});

test('played already, or the sound is off: it comes', () => {
  assert.equal(envelopeDue({ ...base, messages: [voice('ready'), card] }), true);
});

test('never held back past the limit', () => {
  assert.equal(envelopeDue({ ...base, now: at + CUE_MAX_MS }), true);
});
