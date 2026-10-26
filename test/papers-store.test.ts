import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChatStore } from '../src/server/chat/store.js';
import { toBlocks } from '../src/server/papers/schema.js';

const dir = () => mkdtempSync(join(tmpdir(), 'fmv-papers-'));
const blocks = (raw: unknown[]) => toBlocks(raw);

test('a paper is written, finished, and kept whether or not it is saved', () => {
  const store = new ChatStore(dir());
  const paper = store.createPaper({ id: 'P1' });
  assert.equal(paper.status, 'writing');
  assert.equal(paper.savedAt, null);
  const done = store.writePaper('P1', { title: '出门前', blocks: blocks([{ type: 'check', text: '带伞' }]), status: 'done' });
  assert.equal(done.status, 'done');
  assert.equal(done.blocks.length, 1);
  assert.deepEqual(store.papers().map(p => p.id), ['P1'], 'unsaved papers are still there, for the history to open');
  store.close();
});

test('saving puts it on the list once; the first time is the one kept', () => {
  let now = new Date('2026-10-26T10:00:00Z');
  const store = new ChatStore(dir(), () => now);
  store.createPaper({ id: 'P1' });
  const saved = store.savePaper('P1')!;
  assert.equal(saved.savedAt, '2026-10-26T10:00:00.000Z');
  now = new Date('2026-10-27T10:00:00Z');
  assert.equal(store.savePaper('P1')!.savedAt, '2026-10-26T10:00:00.000Z');
  store.close();
});

test('an edit is a new version with history; one by hand is remembered as such', () => {
  const store = new ChatStore(dir());
  store.createPaper({ id: 'P1' });
  store.writePaper('P1', { title: 't', blocks: blocks([{ type: 'paragraph', text: '一' }]), status: 'done' });
  assert.equal(store.userEdited('P1'), false);
  const hers = store.revisePaper('P1', blocks([{ type: 'paragraph', text: '二' }]));
  assert.equal(hers.version, 2);
  assert.equal(store.userEdited('P1'), false, 'her edit is not the user\'s');
  store.revisePaper('P1', blocks([{ type: 'paragraph', text: '三' }]), { byUser: true });
  assert.equal(store.userEdited('P1'), true);
  assert.deepEqual(store.paperHistory('P1').map(v => v.version), [1, 2]);
  store.close();
});

test('the stage remembers which paper is on it, across a restart', () => {
  const path = dir();
  const store = new ChatStore(path);
  store.createPaper({ id: 'P1' });
  store.writePaper('P1', { title: 't', blocks: blocks([{ type: 'paragraph', text: '一' }]), status: 'done' });
  store.setStage('P1');
  store.close();
  const reopened = new ChatStore(path);
  assert.equal(reopened.stage(), 'P1');
  reopened.setStage(null);
  assert.equal(reopened.stage(), null);
  reopened.close();
});

test('deleted from the list: gone from it and from the stage, but the history card still knows it was there', () => {
  const store = new ChatStore(dir());
  store.createPaper({ id: 'P1' });
  store.setStage('P1');
  assert.equal(store.deletePaper('P1'), true);
  assert.equal(store.paper('P1'), null);
  assert.deepEqual(store.papers(), []);
  assert.equal(store.stage(), null);
  store.close();
});

test('a paper still being written when the process died is finished as far as it got; an empty one is gone', () => {
  const path = dir();
  const store = new ChatStore(path);
  store.createPaper({ id: 'P1' });
  store.writePaper('P1', { title: 't', blocks: blocks([{ type: 'paragraph', text: '写了一半' }]) });
  store.createPaper({ id: 'P2' });
  const message = store.append({ role: 'assistant', kind: 'paper', text: '（写下了「无题」）', paperId: 'P2' });
  store.linkPaper('P2', message.id);
  store.setStage('P2');
  store.close();
  const reopened = new ChatStore(path);
  assert.equal(reopened.paper('P1')?.status, 'done');
  assert.equal(reopened.paper('P2'), null);
  assert.equal(reopened.get(message.id), null, 'its history card goes with it');
  assert.equal(reopened.stage(), null);
  reopened.close();
});

test('an install from the letters-and-notes days opens with everything as papers', () => {
  const path = dir();
  const db = new DatabaseSync(resolve(path, 'chat.sqlite'));
  db.exec(`
    CREATE TABLE messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, role TEXT NOT NULL, kind TEXT NOT NULL,
      text TEXT NOT NULL, emotion TEXT, audio TEXT, created_at TEXT NOT NULL, initiative TEXT, letter_id TEXT);
    CREATE TABLE letters (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
      blocks_json TEXT NOT NULL, history_json TEXT NOT NULL DEFAULT '[]', signature TEXT NOT NULL,
      created_at TEXT NOT NULL, opened_at TEXT, deleted_at TEXT, message_id TEXT);
    CREATE TABLE notes (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
      blocks_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE filed_notes (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
      blocks_json TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  const body = JSON.stringify([{ id: 'b1', type: 'paragraph', text: '亲爱的' }, { id: 'b3', type: 'paragraph', text: '晚安' }]);
  db.prepare(`INSERT INTO letters VALUES ('L1', '晚安', 'done', 2, ?, '[]', 'Natasha', '2026-10-20T10:00:00.000Z', NULL, NULL, 'M1')`).run(body);
  db.prepare(`INSERT INTO letters VALUES ('L2', '断了', 'broken', 1, ?, '[]', 'Natasha', '2026-10-21T10:00:00.000Z', NULL, NULL, NULL)`)
    .run(JSON.stringify([{ id: 'b1', type: 'paragraph', text: '写到' }]));
  db.prepare(`INSERT INTO filed_notes VALUES ('N1', '采购', 'done', 1, ?, '2026-10-19T10:00:00.000Z')`)
    .run(JSON.stringify([{ id: 'b1', type: 'item', name: '酱油', note: '', link: null }]));
  db.prepare(`INSERT INTO notes VALUES ('N2', '桌上的', 'done', 1, '[]', '2026-10-22T10:00:00.000Z')`).run();
  db.prepare(`INSERT INTO messages (id, role, kind, text, created_at, letter_id) VALUES ('M1', 'assistant', 'letter', '（写了一封信「晚安」）', '2026-10-20T10:00:00.000Z', 'L1')`).run();
  db.close();

  const store = new ChatStore(path);
  const letter = store.paper('L1')!;
  assert.equal(letter.savedAt, '2026-10-20T10:00:00.000Z', 'a letter was always kept');
  assert.deepEqual(letter.blocks.at(-1), { id: 'b4', type: 'paragraph', text: 'Natasha' }, 'the signature is the last line of it now');
  assert.equal(store.paper('L2')?.status, 'done', 'broken is just as far as it got');
  assert.equal(store.paper('N1')?.savedAt, '2026-10-19T10:00:00.000Z', 'a kept note is a saved paper');
  assert.equal(store.paper('N2'), null, 'a note left on the table was closed');
  const message = store.get('M1')!;
  assert.equal(message.kind, 'paper');
  assert.equal(message.paperId, 'L1');
  assert.equal(store.paperMessageId('L1'), 'M1');
  store.close();

  // Opening again changes nothing: the move happens once.
  const again = new ChatStore(path);
  assert.equal(again.paper('L1')!.blocks.length, 3);
  again.close();
});
