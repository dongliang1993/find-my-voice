import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatStore } from '../src/server/chat/store.js';
import { MemoryExtractor, type Extraction } from '../src/server/memory/extractor.js';

const NOW = new Date('2026-10-22T14:00:00+08:00');

function setup(extraction: Extraction | (() => Promise<Extraction>)) {
  const dir = mkdtempSync(join(tmpdir(), 'fmv-mem-'));
  const store = new ChatStore(dir);
  const prompts: string[] = [];
  const extractor = new MemoryExtractor({
    store, dataDir: dir, now: () => NOW,
    extract: async prompt => { prompts.push(prompt); return typeof extraction === 'function' ? extraction() : extraction; },
  });
  return { dir, store, extractor, prompts };
}

test('does nothing when there is no new conversation', async () => {
  const { extractor, prompts } = setup({ facts: [], followups: [] });
  assert.equal(await extractor.run(), 'nothing_new');
  assert.equal(prompts.length, 0);
});

test('appends new facts under a dated heading and keeps what the user wrote', async () => {
  const { dir, store, extractor } = setup({ facts: ['在一家游戏公司做前端', '养了一只叫团子的猫'], followups: [] });
  writeFileSync(join(dir, 'MEMORY.md'), '# 关于他\n- 喜欢下雨天（我自己写的）\n');
  store.append({ role: 'user', kind: 'text', text: '我家团子今天又打翻水杯了' });
  assert.equal(await extractor.run(), 'updated');
  const memory = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
  assert.match(memory, /喜欢下雨天（我自己写的）/);
  assert.match(memory, /## 2026-10-22/);
  assert.match(memory, /- 养了一只叫团子的猫/);
});

test('creates MEMORY.md when there is none', async () => {
  const { dir, store, extractor } = setup({ facts: ['叫阿亮'], followups: [] });
  store.append({ role: 'user', kind: 'text', text: '我叫阿亮' });
  await extractor.run();
  assert.match(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), /- 叫阿亮/);
});

test('a second run on the same day extends that day instead of repeating the heading', async () => {
  let facts = ['事实一'];
  const { dir, store, extractor } = setup(async () => ({ facts, followups: [] }));
  store.append({ role: 'user', kind: 'text', text: 'a' });
  await extractor.run();
  facts = ['事实二'];
  store.append({ role: 'user', kind: 'text', text: 'b' });
  await extractor.run();
  const memory = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
  assert.equal(memory.match(/## 2026-10-22/g)?.length, 1);
  assert.match(memory, /- 事实一\n- 事实二/);
});

test('stores follow-ups with a resolved due time, and ignores ones already in the past', async () => {
  const { store, extractor } = setup({ facts: [], followups: [
    { topic: '周四的面试', note: '有点紧张', dueAt: '2026-10-23T20:00:00+08:00' },
    { topic: '昨天的事', note: '', dueAt: '2026-10-21T10:00:00+08:00' },
    { topic: '乱写的时间', note: '', dueAt: 'not a date' },
  ] });
  store.append({ role: 'user', kind: 'text', text: '后天面试，好紧张' });
  await extractor.run();
  const due = store.dueFollowups(new Date('2026-10-30T00:00:00Z'));
  assert.deepEqual(due.map(f => f.topic), ['周四的面试']);
});

test('only reads messages since the last run', async () => {
  const { store, extractor, prompts } = setup({ facts: [], followups: [] });
  store.append({ role: 'user', kind: 'text', text: '第一段' });
  await extractor.run();
  store.append({ role: 'user', kind: 'text', text: '第二段' });
  await extractor.run();
  assert.match(prompts[0]!, /第一段/);
  assert.doesNotMatch(prompts[1]!, /第一段/);
  assert.match(prompts[1]!, /第二段/);
});

test('the prompt carries existing memory so known facts are not repeated, plus today\'s date', async () => {
  const { dir, store, extractor, prompts } = setup({ facts: [], followups: [] });
  writeFileSync(join(dir, 'MEMORY.md'), '- 养了一只叫团子的猫\n');
  store.append({ role: 'user', kind: 'text', text: '嗯' });
  await extractor.run();
  assert.match(prompts[0]!, /团子/);
  assert.match(prompts[0]!, /2026/);
});

test('a failed extraction does not advance the cursor, so nothing is lost', async () => {
  let fail = true;
  const { store, extractor, prompts } = setup(async () => { if (fail) throw new Error('model down'); return { facts: [], followups: [] }; });
  store.append({ role: 'user', kind: 'text', text: '重要的事' });
  await assert.rejects(extractor.run(), /model down/);
  fail = false;
  await extractor.run();
  assert.match(prompts[1]!, /重要的事/);
});

test('her proactive messages and voice transcripts are part of what is read', async () => {
  const { store, extractor, prompts } = setup({ facts: [], followups: [] });
  store.append({ role: 'assistant', kind: 'voice', text: '早呀', initiative: 'morning' });
  await extractor.run();
  assert.match(prompts[0]!, /早呀/);
});

test('follow-up times without a timezone are dropped, not guessed', async () => {
  const { store, extractor } = setup({ facts: [], followups: [{ topic: '模糊', note: '', dueAt: '2026-10-24T20:00:00' }] });
  store.append({ role: 'user', kind: 'text', text: 'x' });
  await extractor.run();
  assert.equal(store.dueFollowups(new Date('2026-11-01T00:00:00Z')).length, 0);
});

test('a concurrent hand edit of MEMORY.md wins, and extraction moves on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fmv-mem-'));
  const store = new ChatStore(dir);
  let calls = 0;
  const extractor = new MemoryExtractor({ store, dataDir: dir, now: () => NOW, extract: async () => {
    calls++;
    writeFileSync(join(dir, 'MEMORY.md'), '- 我刚手改的\n'); // the user edits while the model runs
    return { facts: ['模型写的'], followups: [] };
  } });
  store.append({ role: 'user', kind: 'text', text: 'x' });
  await extractor.run();
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '- 我刚手改的\n');
  assert.equal(await extractor.run(), 'nothing_new', 'cursor advanced: no endless retry');
  assert.equal(calls, 1);
});
