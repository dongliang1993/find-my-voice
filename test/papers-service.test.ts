import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatService } from '../src/server/chat/service.js';
import { ChatStore } from '../src/server/chat/store.js';
import { toBlocks } from '../src/server/papers/schema.js';
import type { Brain, BrainEvent, BrainSink } from '../src/server/brain/types.js';
import type { PaperBlock, ServerEvent } from '../src/shared/protocol.js';

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
  const store = new ChatStore(mkdtempSync(join(tmpdir(), 'fmv-paper-')));
  const events: ServerEvent[] = [];
  const brain = new ScriptedBrain(scripts);
  const service = new ChatService({ store, createBrain: () => brain, voice: { speak: okVoice } });
  service.subscribe(e => events.push(e));
  return { store, events, service, brain };
}

const films: PaperBlock[] = toBlocks([
  { type: 'heading', text: '电影' },
  { type: 'item', name: '花样年华', note: '如果只看一部，就是它。', link: { kind: 'movie', query: '花样年华 2000' } },
  { type: 'item', name: '迷失东京', note: '适合一个人安静地看。' },
]);
const writes = (paperId = 'P1', blocks = films, title = '下雨天'): BrainEvent[] => [
  { type: 'voice', text: '下雨的周六，适合慢一点的东西。我写下来了。', emotion: null },
  { type: 'paper_start', paperId },
  { type: 'paper_progress', paperId, title, blocks: blocks.slice(0, 1) },
  { type: 'paper_done', paperId, title, blocks },
];
const stageEvents = (events: ServerEvent[]) => events.flatMap(e => (e.type === 'stage' ? [e.paperId] : []));

test('a paper: her words first, then its card in the history, and it is on the stage', async () => {
  const { store, events, service } = setup(play(...writes()));
  await service.send(randomUUID(), '推荐几部电影');
  const [, voice, card] = store.recent();
  assert.equal(voice?.kind, 'voice');
  assert.equal(card?.kind, 'paper');
  assert.equal(card?.paperId, 'P1');
  assert.match(card!.text, /花样年华/, 'the history keeps what she picked, for her memory');
  const paper = store.paper('P1')!;
  assert.equal(paper.status, 'done');
  assert.equal(paper.savedAt, null, 'written is not saved');
  assert.equal(store.stage(), 'P1');
  assert.deepEqual(stageEvents(events), ['P1']);
  assert.ok(events.some(e => e.type === 'paper' && e.paper.id === 'P1' && e.paper.status === 'writing'), 'every page sees it being written');
});

test('a paper with nothing valid in it never happened: only her words remain', async () => {
  const { store, events, service } = setup(play(...writes('P1', [])));
  await service.send(randomUUID(), '推荐几部电影');
  assert.equal(store.paper('P1'), null);
  assert.deepEqual(store.recent().map(m => m.kind), ['text', 'voice']);
  assert.equal(store.stage(), null);
  assert.deepEqual(stageEvents(events), ['P1', null]);
});

test('broken off by an error: kept as far as it got, and nothing is retried', async () => {
  const { store, brain, service } = setup(play(
    { type: 'paper_start', paperId: 'P1' },
    { type: 'paper_progress', paperId: 'P1', title: '下雨天', blocks: films.slice(0, 2) },
    { type: 'error', code: 'BRAIN_OVERLOADED', message: '忙' },
  ));
  await service.send(randomUUID(), '推荐几部电影');
  const paper = store.paper('P1')!;
  assert.equal(paper.status, 'done');
  assert.equal(paper.blocks.length, 2);
  assert.equal(brain.received.length, 1, 'she does not try again on her own');
});

test('a new paper takes the stage; the one it replaces is kept, saved only if the user had changed it', async () => {
  const { store, service } = setup(play(...writes('P1')), play(...writes('P2')), play(...writes('P3')));
  await service.send(randomUUID(), '推荐几部电影');
  await service.send(randomUUID(), '再来几部');
  assert.equal(store.stage(), 'P2');
  assert.equal(store.paper('P1')?.savedAt, null, 'untouched: off the stage, still in the history');

  service.patchBlock('P2', 'b2', '花样年华（重看）');
  await service.send(randomUUID(), '再来几部');
  assert.equal(store.stage(), 'P3');
  assert.ok(store.paper('P2')?.savedAt, 'changed by hand: saved rather than let go');
});

test('saving keeps it on the stage; asked out loud, she saves it herself', async () => {
  const answers: string[] = [];
  const { store, events, service } = setup(play(...writes()), sink => sink({ type: 'paper_save', respond: a => answers.push(a) }));
  await service.send(randomUUID(), '推荐几部电影');
  await service.send(randomUUID(), '留着吧');
  assert.ok(store.paper('P1')?.savedAt);
  assert.equal(store.stage(), 'P1', 'saved is not put away');
  assert.match(answers[0]!, /Papers/);
  assert.ok(events.some(e => e.type === 'paper' && e.paper.id === 'P1' && e.paper.savedAt));
});

test('saved from the page: the same, without her', async () => {
  const { store, service } = setup(play(...writes()));
  await service.send(randomUUID(), '推荐几部电影');
  assert.ok(service.savePaper('P1')?.savedAt);
  assert.equal(store.stage(), 'P1');
  assert.equal(service.savePaper('nope'), null);
});

test('closed: off the stage, and nothing else changes', async () => {
  const { store, events, service } = setup(play(...writes()));
  await service.send(randomUUID(), '推荐几部电影');
  service.closeStage();
  assert.equal(store.stage(), null);
  assert.ok(store.paper('P1'), 'still there for the history to open');
  assert.equal(stageEvents(events).at(-1), null);
});

test('a card in the history puts its paper back on the stage', async () => {
  const { store, service } = setup(play(...writes('P1')), play(...writes('P2')));
  await service.send(randomUUID(), '推荐几部电影');
  await service.send(randomUUID(), '再来几部');
  assert.equal(service.putOnStage('P1')?.id, 'P1');
  assert.equal(store.stage(), 'P1');
  assert.equal(service.putOnStage('nope'), null);
});

test('deleted: off the list and the stage, and every page is told', async () => {
  const { store, events, service } = setup(play(...writes()));
  await service.send(randomUUID(), '推荐几部电影');
  service.savePaper('P1');
  assert.equal(service.deletePaper('P1'), true);
  assert.equal(store.paper('P1'), null);
  assert.equal(store.stage(), null);
  assert.ok(events.some(e => e.type === 'paper_removed' && e.paperId === 'P1'));
});

test('an unprompted turn never leaves a paper behind', async () => {
  const { store, service } = setup(play(...writes()));
  await service.speakUp({ kind: 'echo', reason: 'x' });
  assert.deepEqual(store.papers(), []);
});

// ---- her edits ----

async function editing(ops: unknown, paperId?: string) {
  const answers: string[] = [];
  const ctx = setup(
    play(...writes('P1')),
    play(...writes('P2', films, '再来几部')),
    sink => sink({ type: 'paper_edit', ...(paperId ? { paperId } : {}), ops, respond: text => answers.push(text) }),
  );
  await ctx.service.send(randomUUID(), '推荐几部电影');
  await ctx.service.send(randomUUID(), '再来几部');
  return { ...ctx, answers };
}

test('an edit with no id changes the paper on the stage, op by op, and she hears what did not work', async () => {
  const { store, events, service, answers } = await editing([
    { op: 'replace', blockId: 'b3', block: { type: 'item', name: '小森林', note: '雨天里看做饭' } },
    { op: 'delete', blockId: 'b9' },
  ]);
  await service.send(randomUUID(), '第三部换一部');
  const paper = store.paper('P2')!;
  assert.equal(paper.version, 2);
  assert.equal(paper.blocks[2]?.type === 'item' && paper.blocks[2].name, '小森林');
  assert.equal(store.paper('P1')!.version, 1, 'the one off the stage is untouched');
  assert.match(answers[0]!, /b9/);
  assert.ok(events.some(e => e.type === 'paper_edit' && e.paper.id === 'P2' && e.ops.length === 1));
  assert.match(store.get(store.paperMessageId('P2')!)!.text, /小森林/, 'the history card says what it says now');
});

test('an edit goes to the paper open in Papers, when one is', async () => {
  const { store, service } = await editing([{ op: 'delete', blockId: 'b1' }]);
  service.setReading('P1');
  await service.send(randomUUID(), '把标题删了');
  assert.equal(store.paper('P1')!.blocks.length, 2);
  assert.equal(store.paper('P2')!.blocks.length, 3);
});

test('an edit to a paper that is gone is refused, and she is told why', async () => {
  const { service, answers } = await editing([{ op: 'delete', blockId: 'b1' }], 'gone');
  await service.send(randomUUID(), '改一下');
  assert.match(answers[0]!, /找不到/);
});

test('she sees a paper whole when it has changed since she last saw it, and one line when it has not', async () => {
  const { brain, service } = setup(play(...writes()), play());
  await service.send(randomUUID(), '推荐几部电影');
  await service.send(randomUUID(), '谢谢');
  assert.match(brain.received[1]!, /舞台上放着「下雨天」（id: P1）/);
  assert.doesNotMatch(brain.received[1]!, /b2 条目/, 'what she wrote herself she already knows');

  service.patchBlock('P1', 'b2', '花样年华（重看）');
  await service.send(randomUUID(), '我改了一下');
  assert.match(brain.received[2]!, /b2 条目：花样年华（重看）/, 'a hand edit is shown to her in full');
  await service.send(randomUUID(), '嗯');
  assert.doesNotMatch(brain.received[3]!, /b2 条目/, 'once seen, one line again');
});

test('with a paper open in Papers she sees all of it', async () => {
  const { brain, service } = setup(play(...writes()), play());
  await service.send(randomUUID(), '推荐几部电影');
  service.setReading('P1');
  await service.send(randomUUID(), '这个怎么样');
  assert.match(brain.received[1]!, /对方正打开着[\s\S]*b3 条目：迷失东京/);
});

// ---- the user's own hand ----

test('a block changed by hand, a box ticked, and the whole text rewritten are edits like any other', async () => {
  const { store, service } = setup(play(
    { type: 'paper_start', paperId: 'P1' },
    { type: 'paper_done', paperId: 'P1', title: '出门前', blocks: toBlocks([{ type: 'paragraph', text: '雨还在下' }, { type: 'check', text: '带伞' }]) },
  ));
  await service.send(randomUUID(), '列一张出门清单');
  const patched = service.patchBlock('P1', 'b1', '雨停了')!;
  assert.deepEqual(patched.blocks[0], { id: 'b1', type: 'paragraph', text: '雨停了' });
  const ticked = service.tickCheck('P1', 'b2', true)!;
  assert.equal(ticked.blocks[1]?.type === 'check' && ticked.blocks[1].done, true);
  const rewritten = service.rewriteText('P1', '## 今晚\n- [x] 关窗\n早点休息')!;
  assert.equal(rewritten.blocks.length, 3);
  assert.ok(rewritten.blocks.every(b => Number(b.id.slice(1)) > 2), 'ids are handed out past any ever used');
  assert.equal(rewritten.version, 4);
  assert.equal(store.userEdited('P1'), true);
  assert.equal(service.patchBlock('nope', 'b1', 'x'), null);
});

test('a hand rewrite keeps the link of every item still named on it', async () => {
  const { service } = setup(play(...writes()));
  await service.send(randomUUID(), '推荐几部电影');
  const rewritten = service.rewriteText('P1', '- 花样年华 —— 再看一遍\n- 海街日记')!;
  assert.deepEqual(rewritten.blocks.map(b => (b.type === 'item' ? b.link : undefined)), [{ kind: 'movie', query: '花样年华 2000' }, null]);
});

test('an item with a link can be opened; one without cannot', async () => {
  const { service } = setup(play(...writes()));
  await service.send(randomUUID(), '推荐几部电影');
  assert.equal(service.paperLink('P1', 'b2'), 'https://search.douban.com/movie/subject_search?search_text=%E8%8A%B1%E6%A0%B7%E5%B9%B4%E5%8D%8E%202000');
  assert.equal(service.paperLink('P1', 'b3'), null);
  assert.equal(service.paperLink('nope', 'b2'), null);
});

test('the hello carries every paper and which one is on the stage', async () => {
  const { service } = setup(play(...writes()));
  await service.send(randomUUID(), '推荐几部电影');
  const hello = service.snapshot();
  assert.deepEqual(hello.papers.map(p => p.id), ['P1']);
  assert.equal(hello.stage, 'P1');
});
