import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wakeAt } from '../src/server/chat/rest.js';

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m);

test('she wakes at the start of the next hours the user likes company, never one already begun', () => {
  // Evening rhythm, 17:00–20:00.
  assert.deepEqual(wakeAt('commute', at(26, 23, 30)), at(27, 17));
  assert.deepEqual(wakeAt('commute', at(26, 10)), at(26, 17), 'before today\'s window: today');
  assert.deepEqual(wakeAt('commute', at(26, 18)), at(27, 17), 'inside it: the next one, not this one again');
});

test('a night rhythm said goodnight to after midnight wakes that same evening', () => {
  assert.deepEqual(wakeAt('night', at(27, 1)), at(27, 21));
  assert.deepEqual(wakeAt('morning', at(26, 22)), at(27, 7));
});

test('with no hours of their own, the next morning', () => {
  assert.deepEqual(wakeAt('anytime', at(26, 23)), at(27, 8));
  assert.deepEqual(wakeAt('anytime', at(27, 2)), at(27, 8));
});

// ---- the service ----

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatService } from '../src/server/chat/service.js';
import { ChatStore } from '../src/server/chat/store.js';
import type { Brain, BrainEvent, BrainSink } from '../src/server/brain/types.js';
import type { ServerEvent } from '../src/shared/protocol.js';

class Scripted implements Brain {
  closed = false;
  turns = 0;
  constructor(private scripts: ((sink: BrainSink) => void)[]) {}
  async reply(_text: string, sink: BrainSink) { this.scripts[Math.min(this.turns++, this.scripts.length - 1)]!(sink); }
  async interrupt() {}
  async close() { this.closed = true; }
}
const play = (...events: BrainEvent[]) => (sink: BrainSink) => { for (const e of events) sink(e); };
const okVoice = async (_id: string, _text: string, { onChunk }: { onChunk: (c: Buffer) => void }) => { onChunk(Buffer.from([1])); return { durationSeconds: 1 }; };

function setup(scripts: ((sink: BrainSink) => void)[], wake = new Date(Date.now() + 3600_000)) {
  const store = new ChatStore(mkdtempSync(join(tmpdir(), 'fmv-rest-')));
  const events: ServerEvent[] = [];
  const answers: string[] = [];
  const service = new ChatService({ store, createBrain: () => new Scripted(scripts), voice: { speak: okVoice }, wakeAt: () => wake });
  service.subscribe(e => events.push(e));
  return { store, events, answers, service };
}
const goodnight = (answers: string[]) => play(
  { type: 'voice', text: '晚安，好好睡。', emotion: null },
  { type: 'rest', respond: a => answers.push(a) },
);
const resting = (events: ServerEvent[]) => events.flatMap(e => (e.type === 'resting' ? [e.until] : []));

test('she says goodnight and rests until the hour she was given; every page is told', async () => {
  const answers: string[] = [];
  const wake = new Date(Date.now() + 3600_000);
  const { events, service } = setup([goodnight(answers)], wake);
  await service.send(randomUUID(), '我要睡了，晚安');
  assert.equal(service.snapshot().resting, wake.toISOString());
  assert.deepEqual(resting(events), [wake.toISOString()]);
  assert.match(answers[0]!, /休息/);
});

test('the user saying anything wakes her before the reply', async () => {
  const answers: string[] = [];
  const { events, service } = setup([goodnight(answers), play({ type: 'text_delta', text: '在呢' })]);
  await service.send(randomUUID(), '晚安');
  await service.send(randomUUID(), '还没睡着');
  assert.equal(service.snapshot().resting, null);
  assert.deepEqual(resting(events).at(-1), null);
});

test('a touch on the page wakes her without a word sent; waking twice says nothing twice', async () => {
  const answers: string[] = [];
  const { events, service } = setup([goodnight(answers)]);
  await service.send(randomUUID(), '晚安');
  service.wake();
  service.wake();
  assert.deepEqual(resting(events).slice(1), [null]);
});

test('she wakes on her own when the hour comes', async () => {
  const answers: string[] = [];
  const { service } = setup([goodnight(answers)], new Date(Date.now() + 30));
  await service.send(randomUUID(), '晚安');
  assert.ok(service.snapshot().resting);
  await new Promise(r => setTimeout(r, 80));
  assert.equal(service.snapshot().resting, null);
  await service.close();
});

test('an hour already past on startup is not slept through', async () => {
  const store = new ChatStore(mkdtempSync(join(tmpdir(), 'fmv-rest-')));
  store.setState('resting_until', new Date(Date.now() - 1000).toISOString());
  const service = new ChatService({ store, createBrain: () => new Scripted([]), voice: { speak: okVoice } });
  assert.equal(service.snapshot().resting, null);
});

test('she cannot rest on her own turn: an unprompted opening is not the user leaving', async () => {
  const answers: string[] = [];
  const { service } = setup([goodnight(answers)]);
  await service.speakUp({ kind: 'echo', reason: 'x' });
  assert.equal(service.snapshot().resting, null);
  assert.match(answers[0]!, /不能/);
});

test('while she rests she does not speak first: the moment is left open, and she stays at rest', async () => {
  const answers: string[] = [];
  const { store, service } = setup([goodnight(answers), play({ type: 'text_delta', text: '在吗' })]);
  await service.send(randomUUID(), '晚安');
  const before = store.recent().length;
  const result = await service.speakUp({ kind: 'rhythm', reason: 'x' });
  assert.equal(result.outcome, 'busy');
  assert.equal(service.resting, true);
  assert.equal(store.recent().length, before, 'nothing said');
});
