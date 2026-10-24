import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatService } from '../src/server/chat/service.js';
import { ChatStore } from '../src/server/chat/store.js';
import type { Brain, BrainEvent, BrainSink } from '../src/server/brain/types.js';
import type { LetterBlock, ServerEvent } from '../src/shared/protocol.js';

/** Plays one script per reply, in order; the last one repeats. */
class ScriptedBrain implements Brain {
  closed = false;
  received: string[] = [];
  constructor(private scripts: ((sink: BrainSink) => Promise<void> | void)[]) {}
  async reply(text: string, sink: BrainSink) {
    this.received.push(text);
    const script = this.scripts[Math.min(this.received.length - 1, this.scripts.length - 1)]!;
    await script(sink);
  }
  async interrupt() {}
  async close() { this.closed = true; }
}

const play = (...events: BrainEvent[]) => (sink: BrainSink) => { for (const e of events) sink(e); };
const okVoice = async (_id: string, _text: string, { onChunk }: { onChunk: (c: Buffer) => void }) => { onChunk(Buffer.from([1])); return { durationSeconds: 1 }; };

function setup(...scripts: ((sink: BrainSink) => Promise<void> | void)[]) {
  const store = new ChatStore(mkdtempSync(join(tmpdir(), 'fmv-letter-')));
  const events: ServerEvent[] = [];
  const brain = new ScriptedBrain(scripts);
  const service = new ChatService({ store, createBrain: () => brain, voice: { speak: okVoice }, signature: () => 'Vivi' });
  service.subscribe(e => events.push(e));
  return { store, events, service, brain };
}

const films: LetterBlock[] = [
  { id: 'b1', type: 'heading', text: '电影' },
  { id: 'b2', type: 'item', name: '花样年华', note: '如果只看一部，就是它。', link: { kind: 'movie', query: '花样年华 2000' } },
  { id: 'b3', type: 'item', name: '迷失东京', note: '适合一个人安静地看。', link: null },
];
const writes = (letterId = 'L1', blocks = films): BrainEvent[] => [
  { type: 'voice', text: '下雨的周六，适合慢一点的东西。我写给你了。', emotion: null },
  { type: 'letter_start', letterId },
  { type: 'letter_progress', letterId, title: '下雨', blocks: blocks.slice(0, 1) },
  { type: 'letter_done', letterId, title: '下雨天', blocks },
];

test('a letter: her words first, then the envelope in the history, then the finished letter', async () => {
  const { store, events, service } = setup(play(...writes()));
  await service.send(randomUUID(), '推荐几部下雨天看的电影');
  const [, voice, card] = store.recent();
  assert.equal(voice?.kind, 'voice', 'what she said comes before the envelope');
  assert.equal(card?.kind, 'letter');
  assert.equal(card?.letterId, 'L1');
  assert.equal(card?.text, '（写了一封信「下雨天」：花样年华、迷失东京）', 'the history line names what she picked');

  const letter = store.letter('L1')!;
  assert.equal(letter.status, 'done');
  assert.equal(letter.signature, 'Vivi');
  assert.equal(letter.blocks.length, 3);

  const snapshots = events.flatMap(e => (e.type === 'letter' ? [e.letter] : []));
  assert.deepEqual(snapshots.map(l => `${l.status}:${l.blocks.length}`), ['writing:0', 'writing:1', 'done:3'], 'it grows while she writes');
  assert.deepEqual(service.snapshot().letters.map(l => l.id), ['L1'], 'and a fresh page gets it with hello');
});

test('a letter with nothing valid in it never happened: only her words remain', async () => {
  const { store, events, service } = setup(play(...writes('L1', [])));
  await service.send(randomUUID(), '推荐几部电影');
  assert.equal(store.letter('L1'), null);
  assert.equal(store.recent().some(m => m.kind === 'letter'), false);
  assert.ok(events.some(e => e.type === 'letter_removed' && e.letterId === 'L1'));
  assert.equal(store.recent().at(-1)?.kind, 'voice');
});

test('broken off by an error: kept as written, and she tries once more on her own', async () => {
  const { store, service, brain } = setup(
    play({ type: 'letter_start', letterId: 'L1' }, { type: 'letter_progress', letterId: 'L1', title: '下雨天', blocks: films.slice(0, 2) },
      { type: 'error', code: 'BRAIN_OVERLOADED', message: '忙' }),
    play(...writes('L2')),
  );
  await service.send(randomUUID(), '推荐几部电影');
  assert.equal(brain.received.length, 2, 'one retry, unprompted by the user');
  assert.match(brain.received[1]!, /写到一半断了，我再试一次/);
  assert.equal(store.letter('L1'), null, 'the broken one gives way to the rewrite');
  assert.equal(store.letter('L2')?.status, 'done');
  assert.equal(store.recent().filter(m => m.kind === 'letter').length, 1);
});

test('when the retry fails too, it stays broken and waits for the user', async () => {
  const breaks = play({ type: 'letter_start', letterId: 'L1' }, { type: 'letter_progress', letterId: 'L1', title: 't', blocks: films.slice(0, 1) },
    { type: 'error', code: 'BRAIN_OVERLOADED', message: '忙' });
  const { store, service, brain } = setup(breaks, play({ type: 'error', code: 'BRAIN_OVERLOADED', message: '忙' }));
  await service.send(randomUUID(), '推荐');
  assert.equal(brain.received.length, 2, 'retried once, not forever');
  assert.equal(store.letter('L1')?.status, 'broken');
  assert.equal(store.letter('L1')?.blocks.length, 1, 'what was written is kept');
});

test('stopped by the user: broken, and no retry — they chose to stop her', async () => {
  let service!: ChatService;
  const setupResult = setup(async sink => {
    sink({ type: 'letter_start', letterId: 'L1' });
    await service.interrupt();
  });
  service = setupResult.service;
  await service.send(randomUUID(), '推荐');
  assert.equal(setupResult.brain.received.length, 1);
  assert.equal(setupResult.store.letter('L1')?.status, 'broken');
});

test('"没写完" clicked: she writes it again, whatever happened before', async () => {
  const breaks = play({ type: 'letter_start', letterId: 'L1' }, { type: 'error', code: 'X', message: 'x' });
  const { store, service, brain } = setup(breaks, breaks, play(...writes('L3')));
  await service.send(randomUUID(), '推荐');
  assert.equal(store.letter('L1')?.status, 'broken');
  assert.equal(service.rewriteLetter('L1'), true);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(brain.received.length, 3);
  assert.equal(store.letter('L3')?.status, 'done');
  assert.equal(service.rewriteLetter('L3'), false, 'only a broken letter can be rewritten');
});

test('an unprompted turn never leaves a letter behind', async () => {
  const { store, service } = setup(play(...writes()));
  await service.speakUp({ kind: 'echo', reason: 'x' });
  assert.equal(store.letters().length, 0);
});

// ---- edits ----

async function written() {
  const answers: string[] = [];
  const ctx = setup(
    play(...writes()),
    sink => sink({
      type: 'letter_edit', letterId: 'L1',
      ops: [{ op: 'replace', blockId: 'b3', block: { type: 'item', name: '小森林', note: '雨天里看做饭的片子' } }, { op: 'delete', blockId: 'b9' }],
      respond: text => answers.push(text),
    }),
  );
  await ctx.service.send(randomUUID(), '推荐几部电影');
  return { ...ctx, answers };
}

test('an edit on an unread letter is refused, and she is told why', async () => {
  const { store, service, answers } = await written();
  await service.send(randomUUID(), '把迷失东京换掉');
  assert.match(answers[0]!, /还没打开/);
  assert.equal(store.letter('L1')?.version, 1);
});

test('an edit on a read letter is a new version, applied op by op, and she hears what did not work', async () => {
  const { store, events, service, answers } = await written();
  service.openLetter('L1');
  await service.send(randomUUID(), '把迷失东京换掉');
  const letter = store.letter('L1')!;
  assert.equal(letter.version, 2);
  assert.equal(letter.blocks[2]?.type === 'item' && letter.blocks[2].name, '小森林');
  assert.match(answers[0]!, /改好了/);
  assert.match(answers[0]!, /b9/, 'the bad op is reported back');
  const edit = events.find(e => e.type === 'letter_edit');
  assert.deepEqual(edit?.type === 'letter_edit' && edit.ops.map(o => o.op), ['replace'], 'the page animates only what happened');
  assert.equal(store.recent().find(m => m.kind === 'letter')?.text, '（写了一封信「下雨天」：花样年华、小森林）', 'the history line follows the latest version');
  assert.equal(store.letterHistory('L1')[0]?.version, 1, 'the old version is kept');
});

// ---- what she is told about the letter ----

test('with the letter open she sees all of it with ids; with it only on the stage, one line', async () => {
  const { service, brain } = setup(play(...writes()), play());
  await service.send(randomUUID(), '推荐几部电影');
  await service.send(randomUUID(), '谢谢');
  assert.match(brain.received[1]!, /舞台上还放着你写的信「下雨天」（id: L1）/);
  assert.doesNotMatch(brain.received[1]!, /b2 条目/);
  service.setReading('L1');
  await service.send(randomUUID(), '第二部换掉');
  assert.match(brain.received[2]!, /对方正打开着你写的信/);
  assert.match(brain.received[2]!, /b2 条目：花样年华/);
  assert.match(brain.received[2]!, /第二部换掉$/, 'their words come last, untouched');
});

test('the note never reaches the history: the user message is stored as said', async () => {
  const { store, service } = setup(play(...writes()), play());
  await service.send(randomUUID(), '推荐几部电影');
  service.setReading('L1');
  await service.send(randomUUID(), '第二部换掉');
  assert.equal(store.recent().filter(m => m.role === 'user').at(-1)?.text, '第二部换掉');
});

test('open and delete reach every page', async () => {
  const { events, service } = setup(play(...writes()));
  await service.send(randomUUID(), '推荐');
  assert.ok(service.openLetter('L1')?.openedAt);
  assert.ok(service.deleteLetter('L1'));
  assert.ok(events.some(e => e.type === 'letter_removed' && e.letterId === 'L1'));
  assert.equal(service.snapshot().letters.length, 0);
});
