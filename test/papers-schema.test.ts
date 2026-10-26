import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePartialJson } from '../src/server/papers/partial.js';
import { applyOps, describePaper, nextBlockNumber, paperSummary, toBlocks, toTitle } from '../src/server/papers/schema.js';
import { linkUrl } from '../src/shared/links.js';
import type { PaperBlock } from '../src/shared/protocol.js';

// ---- the streaming parser ----

test('a finished document parses as it is', () => {
  assert.deepEqual(parsePartialJson('{"title":"下雨天","blocks":[]}'), { title: '下雨天', blocks: [] });
});

test('a string cut mid-way comes back cut, inside its closed brackets', () => {
  assert.deepEqual(parsePartialJson('{"title":"下雨天","blocks":[{"type":"item","name":"花样'),
    { title: '下雨天', blocks: [{ type: 'item', name: '花样' }] });
});

test('a key with no value yet is left out', () => {
  assert.deepEqual(parsePartialJson('{"title":"下雨天","blo'), { title: '下雨天' });
  assert.deepEqual(parsePartialJson('{"title":"下雨天","blocks":'), { title: '下雨天' });
  assert.deepEqual(parsePartialJson('{"title":"下雨天","blocks":[{"type":"item","name":"a","note":'),
    { title: '下雨天', blocks: [{ type: 'item', name: 'a' }] });
});

test('half a literal is dropped, not guessed', () => {
  assert.deepEqual(parsePartialJson('{"a":1,"b":tr'), { a: 1 });
  assert.deepEqual(parsePartialJson('{"a":[1,2,'), { a: [1, 2] });
});

test('escapes survive, and one cut in half does not break the rest', () => {
  assert.deepEqual(parsePartialJson('{"text":"他说\\"下雨\\"了'), { text: '他说"下雨"了' });
  assert.deepEqual(parsePartialJson('{"text":"line one\\'), { text: 'line one' });
  assert.deepEqual(parsePartialJson('{"text":"a\\u4e'), {}, 'half a unicode escape: the whole value waits');
});

test('nothing readable yet is undefined', () => {
  assert.equal(parsePartialJson(''), undefined);
  assert.deepEqual(parsePartialJson('{'), {});
});

// ---- blocks ----

test('blocks get ids by the position they were written in, and bad ones drop out without renumbering', () => {
  const blocks = toBlocks([
    { type: 'paragraph', text: '下雨的周六，适合慢一点的东西。' },
    { type: 'item' },
    { type: 'item', name: '花样年华', note: '如果只看一部，就是它。', link: { kind: 'movie', query: '花样年华 2000' } },
  ]);
  assert.deepEqual(blocks.map(b => b.id), ['b1', 'b3']);
  assert.deepEqual(blocks[1], { id: 'b3', type: 'item', name: '花样年华', note: '如果只看一部，就是它。', link: { kind: 'movie', query: '花样年华 2000' } });
});

test('markup is stripped from every field, and a poem keeps its lines', () => {
  const [heading, item, poem] = toBlocks([
    { type: 'heading', text: '## **电影**' },
    { type: 'item', name: '<b>迷失东京</b>', note: '*安静*' },
    { type: 'paragraph', text: '雨落在窗上\n  像有人轻轻敲门\n\n\n\n你不用开' },
  ]);
  assert.equal(heading?.type === 'heading' && heading.text, '电影');
  assert.equal(item?.type === 'item' && `${item.name}|${item.note}`, '迷失东京|安静');
  assert.equal(poem?.type === 'paragraph' && poem.text, '雨落在窗上\n像有人轻轻敲门\n\n你不用开');
});

test('a link only for kinds the page knows, and its query falls back to the name', () => {
  const [a, b, c] = toBlocks([
    { type: 'item', name: '花样年华', link: { kind: 'movie', query: '' } },
    { type: 'item', name: 'x', link: { kind: 'url', query: 'https://evil.example' } },
    { type: 'item', name: 'y' },
  ]);
  assert.deepEqual(a?.type === 'item' && a.link, { kind: 'movie', query: '花样年华' });
  assert.equal(b?.type === 'item' && b.link, null);
  assert.equal(c?.type === 'item' && c.link, null);
});

test('a block still streaming in shows what it has so far', () => {
  assert.deepEqual(toBlocks([{ type: 'item', name: '花' }, { type: 'ite' }]).map(b => b.id), ['b1']);
});

test('titles are one short line', () => {
  assert.equal(toTitle('  **下雨天**\n'), '下雨天');
});

// ---- edits ----

const paper: PaperBlock[] = [
  { id: 'b1', type: 'heading', text: '电影' },
  { id: 'b2', type: 'item', name: '花样年华', note: '', link: null },
  { id: 'b3', type: 'item', name: '迷失东京', note: '', link: null },
];

test('replace keeps the id, delete removes it, insert gets a fresh one', () => {
  const { blocks, ops, errors } = applyOps(paper, [
    { op: 'replace', blockId: 'b3', block: { type: 'item', name: '小森林', note: '雨天里看做饭' } },
    { op: 'delete', blockId: 'b2' },
    { op: 'insert', afterBlockId: 'b1', block: { type: 'item', name: '海街日记' } },
  ], 4);
  assert.deepEqual(errors, []);
  assert.deepEqual(blocks.map(b => b.id), ['b1', 'b4', 'b3']);
  assert.deepEqual(ops.map(o => o.op), ['replace', 'delete', 'insert']);
  const inserted = ops[2];
  assert.equal(inserted?.op === 'insert' && inserted.block.id, 'b4');
});

test('a bad op is reported and skipped, the rest still apply', () => {
  const { blocks, ops, errors } = applyOps(paper, [
    { op: 'delete', blockId: 'b9' },
    { op: 'replace', blockId: 'b2', block: { type: 'item' } },
    { op: 'delete', blockId: 'b3' },
  ], 4);
  assert.equal(errors.length, 2);
  assert.match(errors[0]!, /b9/);
  assert.deepEqual(blocks.map(b => b.id), ['b1', 'b2']);
  assert.equal(ops.length, 1);
});

test('insert at the very top', () => {
  const { blocks } = applyOps(paper, [{ op: 'insert', afterBlockId: null, block: { type: 'paragraph', text: '先说一句' } }], 4);
  assert.equal(blocks[0]?.id, 'b4');
});

test('a deleted id is never handed out again', () => {
  const now: PaperBlock[] = [{ id: 'b1', type: 'heading', text: 'x' }];
  const before: PaperBlock[] = [...now, { id: 'b7', type: 'heading', text: 'y' }];
  assert.equal(nextBlockNumber(now, before), 8);
});

// ---- describing a paper ----

test('the model sees every block with its id', () => {
  const text = describePaper({ id: 'L1', title: '下雨天', blocks: paper });
  assert.match(text, /「下雨天」（id: L1）/);
  assert.match(text, /b2 条目：花样年华/);
  assert.match(text, /b1 小标题：电影/);
});

test('the history keeps the title and the names, not the whole paper', () => {
  assert.equal(paperSummary({ title: '下雨天', blocks: paper }), '（写下了「下雨天」：花样年华、迷失东京）');
  assert.equal(paperSummary({ title: '给你的诗', blocks: [{ id: 'b1', type: 'paragraph', text: '雨落在窗上\n像有人轻轻敲门' }] }),
    '（写下了「给你的诗」：雨落在窗上 像有人轻轻敲门）');
  assert.equal(paperSummary({ title: '出门前', blocks: [{ id: 'b1', type: 'check', text: '带伞', done: false }] }), '（写下了「出门前」：带伞）');
});

// ---- links ----

test('every kind opens where it was agreed, and the query is encoded', () => {
  assert.equal(linkUrl({ kind: 'movie', query: '花样年华 2000' }), 'https://search.douban.com/movie/subject_search?search_text=%E8%8A%B1%E6%A0%B7%E5%B9%B4%E5%8D%8E%202000');
  assert.match(linkUrl({ kind: 'book', query: 'x' }), /^https:\/\/search\.douban\.com\/book\//);
  assert.match(linkUrl({ kind: 'music', query: 'Bill Evans' }), /^https:\/\/music\.163\.com\/#\/search\/m\/\?s=Bill%20Evans/);
  assert.match(linkUrl({ kind: 'place', query: '鼓浪屿' }), /^https:\/\/maps\.apple\.com\/\?q=/);
  assert.match(linkUrl({ kind: 'web', query: 'a&b' }), /q=a%26b$/);
});
