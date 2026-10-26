import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceOnce } from '../src/server/brain/once.js';

test('a voice seen first in the stream is not sent again by its tool call', () => {
  const once = new VoiceOnce();
  assert.equal(once.claim('stream', '你好'), true);
  assert.equal(once.claim('tool', '你好'), false);
});

test('a tool call that runs before the stream reaches it is not sent again by the stream', () => {
  const once = new VoiceOnce();
  assert.equal(once.claim('tool', '你好'), true);
  assert.equal(once.claim('stream', '你好'), false);
});

test('the same words said twice in a turn are two voices, each sent once', () => {
  const once = new VoiceOnce();
  assert.equal(once.claim('stream', '嗯'), true);
  assert.equal(once.claim('tool', '嗯'), false);
  assert.equal(once.claim('tool', '嗯'), true);
  assert.equal(once.claim('stream', '嗯'), false);
});

test('a new turn forgets what the last one said', () => {
  const once = new VoiceOnce();
  once.claim('stream', '你好');
  once.reset();
  assert.equal(once.claim('tool', '你好'), true);
});
