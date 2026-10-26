import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatService } from '../src/server/chat/service.js';
import { ChatStore } from '../src/server/chat/store.js';
import type { Brain, BrainSink, PreferencesPatch } from '../src/server/brain/types.js';
import type { ServerEvent } from '../src/shared/protocol.js';

const okVoice = async () => ({ durationSeconds: 1 });

function setup(script: (sink: BrainSink) => void, updatePreferences?: (patch: PreferencesPatch) => string) {
  const store = new ChatStore(mkdtempSync(join(tmpdir(), 'fmv-prefs-')));
  let closed = 0;
  const brain: Brain = {
    closed: false,
    async reply(_text, sink) { script(sink); },
    async interrupt() {},
    async close() { closed++; },
  };
  const events: ServerEvent[] = [];
  const chat = new ChatService({ store, createBrain: () => brain, voice: { speak: okVoice }, updatePreferences });
  chat.subscribe(e => events.push(e));
  return { chat, events, closed: () => closed };
}

test('asked out loud, she changes a preference and every page is told', async () => {
  const applied: PreferencesPatch[] = [];
  let answer = '';
  const s = setup(
    sink => sink({ type: 'preferences', patch: { initiative: 'off' }, respond: r => { answer = r; } }),
    patch => { applied.push(patch); return '改好了'; },
  );
  await s.chat.send(randomUUID(), '这几天别主动找我');
  assert.deepEqual(applied, [{ initiative: 'off' }]);
  assert.equal(answer, '改好了', 'the answer is hers to confirm');
  assert.ok(s.events.some(e => e.type === 'settings'));
  assert.equal(s.closed(), 0, 'the turn that asked is not cut off');
});

test('a request with nothing in it changes nothing', async () => {
  let answer = '';
  let calls = 0;
  const s = setup(sink => sink({ type: 'preferences', patch: {}, respond: r => { answer = r; } }), () => { calls++; return ''; });
  await s.chat.send(randomUUID(), '嗯');
  assert.equal(calls, 0);
  assert.match(answer, /没有要改/);
  assert.ok(!s.events.some(e => e.type === 'settings'));
});

test('a preference that fails to save is said so, not claimed', async () => {
  let answer = '';
  const s = setup(
    sink => sink({ type: 'preferences', patch: { language: 'zh' }, respond: r => { answer = r; } }),
    () => { throw new Error('disk full'); },
  );
  await s.chat.send(randomUUID(), '以后用中文跟我说');
  assert.match(answer, /没改成/);
  assert.ok(!s.events.some(e => e.type === 'settings'));
});
