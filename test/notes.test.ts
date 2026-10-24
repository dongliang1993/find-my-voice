import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatService } from '../src/server/chat/service.js';
import { ChatStore } from '../src/server/chat/store.js';
import { describeNote, toBlocks } from '../src/server/letters/schema.js';
import { noteText, parseNoteText } from '../src/shared/notes.js';
import type { Brain, BrainEvent, BrainSink } from '../src/server/brain/types.js';
import type { LetterBlock, Note, ServerEvent } from '../src/shared/protocol.js';

const dir = () => mkdtempSync(join(tmpdir(), 'fmv-notes-'));
const blocks = (raw: unknown[]): LetterBlock[] => toBlocks(raw);
const paragraph = (text: string): LetterBlock => ({ id: `b${Math.random()}`, type: 'paragraph', text });

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

function service() {
  const store = new ChatStore(dir());
  const events: ServerEvent[] = [];
  const noteEvents = (): Note[] => events.flatMap(e => (e.type === 'note' ? [e.note] : []));
  const mk = (...scripts: ((sink: BrainSink) => Promise<void> | void)[]) => {
    const brain = new ScriptedBrain(scripts);
    const chat = new ChatService({ store, createBrain: () => brain, voice: { speak: okVoice } });
    chat.subscribe(e => events.push(e));
    return { chat, brain };
  };
  return { store, events, noteEvents, mk };
}

test('a note is created writing, and finished by writing again', () => {
  const store = new ChatStore(dir());
  const note = store.putNote({ title: '今晚的安排', blocks: blocks([{ type: 'paragraph', text: '先吃饭' }]) });
  assert.equal(note.status, 'writing');
  assert.equal(note.title, '今晚的安排');

  const done = store.writeNote(note.id, { title: '今晚的安排', blocks: [...note.blocks, paragraph('再散步')], status: 'done' });
  assert.equal(done?.status, 'done');
  assert.equal(done?.blocks.length, 2);
  store.close();
});

test('there is only ever one note: a new one replaces the last', () => {
  const store = new ChatStore(dir());
  store.putNote({ title: '第一张', blocks: [paragraph('旧的')] });
  const second = store.putNote({ title: '第二张', blocks: [paragraph('新的')] });
  assert.equal(store.note()?.id, second.id);
  assert.equal(store.note()?.title, '第二张');
  store.close();
});

test('a note interrupted by a dead process does not survive a restart', () => {
  const path = dir();
  const first = new ChatStore(path);
  first.putNote({ title: '没写完', blocks: [paragraph('半张')] });
  first.close();
  const second = new ChatStore(path);
  assert.equal(second.note(), null, 'a leftover note counts as closed: one row, wiped once');
  second.close();
});

test('closing a note removes it entirely', () => {
  const store = new ChatStore(dir());
  const note = store.putNote({ title: '待办', blocks: [paragraph('一条')] });
  assert.equal(store.removeNote(note.id), true);
  assert.equal(store.note(), null);
  assert.equal(store.removeNote(note.id), false, 'closing twice changes nothing the second time');
  store.close();
});

test('an edit revises the blocks and bumps the version, keeping no history', () => {
  const store = new ChatStore(dir());
  const note = store.putNote({ title: '采购', blocks: blocks([{ type: 'item', name: '酱油', note: '生抽' }]), status: 'done' });
  const revised = store.reviseNote(note.id, [...note.blocks, paragraph('再加一瓶醋')]);
  assert.equal(revised?.version, note.version + 1);
  assert.equal(revised?.blocks.length, 2);
  assert.equal(store.letterHistory(note.id).length, 0, 'letters keep history; notes keep none');
  store.close();
});

test('describeNote lists every block with its id, like a letter', () => {
  const note = { title: '安排', blocks: blocks([
    { type: 'heading', text: '上午' },
    { type: 'item', name: '买菜', note: '早点去' },
    { type: 'paragraph', text: '下午没事' },
  ]) };
  const text = describeNote(note);
  assert.match(text, /便签「安排」/);
  assert.match(text, /小标题：上午/);
  assert.match(text, /条目：买菜——早点去/);
  assert.match(text, /段落：下午没事/);
});

test('the card goes up the moment the call starts, and grows line by line', async () => {
  const { store, noteEvents, mk } = service();
  const { chat } = mk(play(
    { type: 'note_start', noteId: 'N1' },
    { type: 'note_progress', noteId: 'N1', title: '出门前', blocks: blocks([{ type: 'paragraph', text: '雨还在下' }]) },
    { type: 'note_progress', noteId: 'N1', title: '出门前', blocks: blocks([{ type: 'paragraph', text: '雨还在下' }, { type: 'heading', text: '要带的东西' }]) },
    { type: 'note_done', noteId: 'N1', title: '出门前', blocks: blocks([{ type: 'paragraph', text: '雨还在下' }, { type: 'heading', text: '要带的东西' }, { type: 'item', name: '伞', note: '楼下那把黑的' }]) },
  ));
  await chat.send(randomUUID(), '帮我列一张出门前的清单');
  assert.deepEqual(noteEvents().map(n => `${n.status}:${n.blocks.length}`),
    ['writing:0', 'writing:1', 'writing:2', 'done:3'],
    'the empty card is up before the first line, and each line lands as it is written');
  assert.equal(store.note()?.blocks.at(-1)?.type, 'item');
});

test('a second call appends without doubling what the first wrote', async () => {
  const { store, noteEvents, mk } = service();
  const { chat } = mk(play(
    { type: 'note_start', noteId: 'N1' },
    { type: 'note_progress', noteId: 'N1', title: '出门前', blocks: blocks([{ type: 'paragraph', text: '雨还在下' }]) },
    { type: 'note_done', noteId: 'N1', title: '出门前', blocks: blocks([{ type: 'paragraph', text: '雨还在下' }]) },
  ));
  await chat.send(randomUUID(), '列一张出门清单');
  const first = store.note()!;

  // A later call streams under a fresh id: the base is what was on the table
  // when it began, so its ticks replace only what it has written.
  const { chat: chat2 } = mk(play(
    { type: 'note_start', noteId: 'N2' },
    { type: 'note_progress', noteId: 'N2', title: '再带一件', blocks: blocks([{ type: 'item', name: '外套', note: '玄关椅子上那件' }]) },
    { type: 'note_progress', noteId: 'N2', title: '再带一件', blocks: blocks([{ type: 'item', name: '外套', note: '玄关椅子上那件' }, { type: 'item', name: '围巾', note: '第二条' }]) },
    { type: 'note_done', noteId: 'N2', title: '再带一件', blocks: blocks([{ type: 'item', name: '外套', note: '玄关椅子上那件' }, { type: 'item', name: '围巾', note: '第二条' }]) },
  ));
  await chat2.send(randomUUID(), '再加两件');
  const appended = store.note()!;
  assert.equal(appended.id, first.id, 'the one on the table keeps its place');
  assert.deepEqual(appended.blocks.map(b => b.type === 'item' ? b.name : b.text),
    ['雨还在下', '外套', '围巾'], 'each streamed line appears once, over the base');
  const growing = noteEvents().filter(n => n.id === appended.id);
  assert.deepEqual(growing.at(-1)?.blocks.length, 3);
  assert.ok(appended.blocks.every((b, i, all) => all.findIndex(x => x.id === b.id) === i), 'ids never collide');
});

test('a call that never caught a line leaves no card', async () => {
  const { store, events, mk } = service();
  const { chat } = mk(play(
    { type: 'note_start', noteId: 'N1' },
    { type: 'error', code: 'BRAIN_OVERLOADED', message: '模型服务繁忙，稍后再试。' },
  ));
  await chat.send(randomUUID(), '列一张清单');
  assert.equal(store.note(), null, 'the card that went up with the call goes back down');
  assert.ok(events.some(e => e.type === 'note_removed' && e.noteId === 'N1'));
});

test('a call stopped with lines on it is finished there, not broken', async () => {
  const { store, noteEvents, mk } = service();
  const { chat } = mk(play(
    { type: 'note_start', noteId: 'N1' },
    { type: 'note_progress', noteId: 'N1', title: '出门前', blocks: blocks([{ type: 'paragraph', text: '雨还在下' }, { type: 'heading', text: '要带的东西' }]) },
    { type: 'error', code: 'BRAIN_OVERLOADED', message: '模型服务繁忙，稍后再试。' },
  ));
  await chat.send(randomUUID(), '列一张出门清单');
  const note = store.note()!;
  assert.equal(note.status, 'done', 'a note never breaks: it says what it says');
  assert.equal(note.blocks.length, 2);
  assert.equal(noteEvents().at(-1)?.status, 'done');
});

test('a check line keeps its box and its tick', async () => {
  const s = service();
  const { chat } = s.mk(play(
    { type: 'note_start', noteId: 'N1' },
    { type: 'note_progress', noteId: 'N1', title: '出门前', blocks: blocks([{ type: 'check', text: '带伞', done: false }]) },
    { type: 'note_done', noteId: 'N1', title: '出门前', blocks: blocks([
      { type: 'check', text: '带伞', done: false },
      { type: 'check', text: '拿钥匙', done: true },
    ]) },
  ));
  await chat.send(randomUUID(), '出门要带什么');
  const store = s.store;
  const note = store.note()!;
  assert.deepEqual(note.blocks.map(b => b.type === 'check' ? [b.text, b.done] : null),
    [['带伞', false], ['拿钥匙', true]], 'the model writes the box ticked or not');
  // The user's own tick: another hand, the same note.
  const ticked = chat.tickNoteCheck(note.blocks[0]!.id, true)!;
  assert.equal(ticked.blocks[0]?.type === 'check' && ticked.blocks[0].done, true);
  assert.equal(ticked.version, note.version + 1, 'a tick is an edit like any other');
});

test('a note filed away is kept in the dock, and comes back from it', async () => {
  const s = service();
  const { chat } = s.mk(play(
    { type: 'note_start', noteId: 'N1' },
    { type: 'note_done', noteId: 'N1', title: '出门前', blocks: blocks([
      { type: 'paragraph', text: '雨还在下' },
      { type: 'check', text: '带伞', done: false },
    ]) },
  ));
  await chat.send(randomUUID(), '列一张出门清单');
  const note = s.store.note()!;

  // Filed: off the table, into the dock. The table is empty after.
  const filed = chat.fileNote()!;
  assert.equal(filed.length, 1);
  assert.equal(s.store.note(), null, 'only one note is ever on the table');
  assert.equal(s.store.filedNotes()[0]?.blocks.length, 2, 'what the dock holds');
  assert.ok(s.events.some(e => e.type === 'note_filed' && e.noteId === note.id));
  assert.equal(s.store.filedNotes()[0]?.status, 'done', 'a note never breaks: filed, it is finished');

  // Back on the table: the dock holds one less, the note keeps its id.
  const back = chat.unfileNote(note.id)!;
  assert.equal(back.id, note.id);
  assert.equal(back.blocks.length, 2);
  assert.equal(s.store.filedNotes().length, 0, 'it left the dock');
  assert.equal(s.store.note()?.id, note.id, 'it is the one on the table again');
  assert.ok(s.noteEvents().some(n => n.id === note.id));
  // The dock is told too: every page drops the icon, not only this one.
  const unfiled = s.events.filter(e => e.type === 'note_unfiled');
  assert.equal(unfiled.length, 1);
  assert.deepEqual(unfiled[0]!.filedNotes, [], 'the event carries the dock as it now stands');
});

test('a filed note survives a new note on the table and a restart', () => {
  const path = dir();
  const store = new ChatStore(path);
  const note = store.putNote({ title: '采购', blocks: blocks([{ type: 'item', name: '酱油' }]), status: 'done' });
  store.fileNote(note);
  // A new note on the table wipes only the table — the dock is apart from it.
  store.putNote({ title: '新的', blocks: [paragraph('换了')] });
  assert.equal(store.filedNotes().length, 1, 'the dock keeps its own');
  store.close();

  const reopened = new ChatStore(path);
  assert.equal(reopened.filedNotes().length, 1, 'a leftover note on the table counts as closed; a filed one is kept');
  assert.equal(reopened.note(), null, 'the table starts empty');
  reopened.close();
});

test('a check written by the model comes out described, done or not', () => {
  const note = { title: '出门', blocks: blocks([
    { type: 'check', text: '带伞', done: false },
    { type: 'check', text: '拿钥匙', done: true },
  ]) };
  const text = describeNote(note);
  assert.match(text, /待办：带伞（未办）/);
  assert.match(text, /待办：拿钥匙（已办）/);
});

test('a card typed freehand is read back as the same lines she writes', () => {
  const text = [
    '雨还在下',
    '',
    '## 要带的东西',
    '- [ ] 带伞',
    '- [x] 拿钥匙',
    '- 水壶 —— 装满温水',
    '',
    '路上慢一点。',
  ].join('\n');
  const parsed = parseNoteText(text);
  assert.deepEqual(parsed.map(b => b.type), ['paragraph', 'heading', 'check', 'check', 'item', 'paragraph']);
  assert.deepEqual(parsed.filter(b => b.type === 'check').map(b => b.type === 'check' && b.done),
    [false, true], 'the box comes out as it was ticked, or not');
  // What the editor opens with, typed back unchanged, says the same thing.
  assert.deepEqual(parseNoteText(noteText(parsed)), parsed);
});

test('the whole card rewritten by hand keeps no ids and answers to none twice', async () => {
  const s = service();
  const { chat } = s.mk(play(
    { type: 'note_start', noteId: 'N1' },
    { type: 'note_done', noteId: 'N1', title: '出门前', blocks: blocks([
      { type: 'paragraph', text: '雨还在下' },
      { type: 'check', text: '带伞', done: false },
    ]) },
  ));
  await chat.send(randomUUID(), '列一张出门清单');
  const note = s.store.note()!;
  const was = note.blocks[0]!.id;

  const rewritten = chat.rewriteNoteText('## 今晚\n- [x] 关窗\n早点休息')!;
  assert.equal(rewritten.version, note.version + 1, 'a freehand rewrite is an edit like any other');
  assert.equal(rewritten.blocks.length, 3);
  const numbers = rewritten.blocks.map(b => Number(/^b(\d+)$/.exec(b.id)![1]));
  assert.ok(Math.min(...numbers) > Number(/^b(\d+)$/.exec(was)![1]), 'ids are handed out past any ever used');
  assert.ok(new Set(rewritten.blocks.map(b => b.id)).size === 3, 'no id answers to two lines');
  assert.equal(s.noteEvents().at(-1)?.version, rewritten.version, 'every page is told');
  assert.deepEqual(rewritten.blocks.filter(b => b.type === 'check').map(b => b.type === 'check' && b.done),
    [true], 'a ticked line comes in ticked');
});
