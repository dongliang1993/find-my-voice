import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatService } from '../src/server/chat/service.js';
import { ChatStore } from '../src/server/chat/store.js';
import type { Brain, BrainSink } from '../src/server/brain/types.js';
import type { ServerEvent } from '../src/shared/protocol.js';

class NullBrain implements Brain {
  closed = false;
  async reply() {}
  async interrupt() {}
  async close() { this.closed = true; }
}

function setup(speak: (id: string, text: string, opts: { onChunk: (c: Buffer) => void; signal?: AbortSignal }) => Promise<{ durationSeconds: number }>) {
  const store = new ChatStore(mkdtempSync(join(tmpdir(), 'fmv-narrate-')));
  const events: ServerEvent[] = [];
  const service = new ChatService({ store, createBrain: () => new NullBrain(), voice: { speak } });
  service.subscribe(e => events.push(e));
  return { store, events, service };
}

test('a text narrate line enters the history like any other message', async () => {
  const { store, service } = setup(async () => ({ durationSeconds: 0 }));
  const { messageId, audioId } = service.narrate('你好，很高兴认识你。');
  const message = store.get(messageId);
  assert.equal(message?.role, 'assistant');
  assert.equal(message?.text, '你好，很高兴认识你。');
  assert.equal(message?.audio, null);
  assert.equal(audioId, null);
});

test('a spoken narrate line goes through the voice pipeline and waits for it', async () => {
  // The voice resolves only when the test releases it; narrateDone must not
  // resolve before that.
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let finished = false;
  const { store, events, service } = setup(async (_id, _text, { onChunk }) => {
    onChunk(Buffer.from([1]));
    await gate;
    finished = true;
    return { durationSeconds: 1 };
  });
  const { messageId, audioId } = service.narrate('这一句要用声音说。', { speak: true });
  const message = store.get(messageId);
  assert.equal(message?.kind, 'voice');
  assert.equal(message?.audio?.state, 'streaming');
  assert.equal(audioId, message?.audio?.id);

  let done = false;
  const waited = service.narrateDone(audioId!).then(() => { done = true; });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(done, false, 'still speaking: not done yet');
  release();
  await waited;
  assert.equal(done, true);
  assert.equal(finished, true);
  assert.equal(store.get(messageId)?.audio?.state, 'ready');
  // The audio chunks actually streamed to the page.
  assert.ok(events.some(e => e.type === 'audio_chunk'));
});

test('a narrate line never wakes the brain', async () => {
  const { service } = setup(async () => ({ durationSeconds: 0 }));
  // No thinking status was ever emitted: the queue never ran.
  const statuses: string[] = [];
  service.subscribe(e => { if (e.type === 'status') statuses.push(e.status); });
  service.narrate('脚本台词');
  service.narrate('再一句');
  assert.deepEqual(statuses, []);
});
