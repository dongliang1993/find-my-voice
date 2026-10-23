import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proposalSchema, proposalPrompt, acceptable } from '../src/server/profile/naming.js';
import { App } from '../src/server/app.js';
import { ChatStore } from '../src/server/chat/store.js';

const dir = () => mkdtempSync(join(tmpdir(), 'fmv-naming-'));

test('the proposal prompt carries the hard rules and what the user said', () => {
  const prompt = proposalPrompt('阿梁', '他说自己在写小说，主角是个守灯塔的人');
  assert.match(prompt, /优先起英文名/);
  assert.match(prompt, /小X/);
  assert.match(prompt, /阿梁/);
  assert.match(prompt, /守灯塔/);
});

test('the schema rejects a missing reason or an over-long name', () => {
  assert.equal(proposalSchema.safeParse({ name: '灯', reason: '因为他写守灯塔的人' }).success, true);
  assert.equal(proposalSchema.safeParse({ name: '灯', reason: '' }).success, false);
  assert.equal(proposalSchema.safeParse({ name: 'x'.repeat(9), reason: 'r' }).success, false);
});

test('existing assistant names and the lazy pattern never reach the screen', () => {
  assert.equal(acceptable({ name: 'Samantha', reason: 'r' }), null);
  assert.equal(acceptable({ name: '小灯', reason: 'r' }), null);
  assert.equal(acceptable({ name: '灯守', reason: '他写的小说里有人守灯塔' }), '灯守');
});

test('exactly one proposal, ever — a restart changes nothing', async () => {
  const d = dir();
  const store = new ChatStore(d);
  store.saveOnboarding(2, { nameProposed: true }, false);
  store.close();

  const app = new App(d, () => {});
  assert.equal(await app.proposeName('阿梁', '写小说'), null, 'already proposed once: the only move left is typing a name');
  await app.close();
});

test('a completed onboarding never proposes a name', async () => {
  const d = dir();
  const store = new ChatStore(d);
  store.saveOnboarding(7, {}, true);
  store.close();

  const app = new App(d, () => {});
  assert.equal(await app.proposeName('阿梁', ''), null);
  await app.close();
});

test('finish lands the names, opens the first pages, and closes for good', async () => {
  const d = dir();
  const app = new App(d, () => {});
  await app.finishOnboarding({
    alias: '阿梁', companionName: '灯守',
    nameOrigin: '我的名字来自他小说里守灯塔的人。',
    notes: '他在写一本小说', comfort: 'listen', rhythm: 'night',
  });
  // Names landed in settings; nothing else stores them.
  assert.equal(app.settings.companion.name, '灯守');
  assert.equal(app.settings.companion.userName, '阿梁');
  assert.equal(app.settings.companion.comfort, 'listen');
  assert.equal(app.settings.companion.rhythm, 'night');
  // Onboarding closed exactly once; replaying changes nothing.
  const finishedAt = app.store.onboarding().completedAt;
  assert.notEqual(finishedAt, null);
  await app.finishOnboarding({
    alias: '别人', companionName: '别的', nameOrigin: '重放', notes: '', comfort: 'cheer', rhythm: 'morning',
  });
  assert.equal(app.settings.companion.name, '灯守', 'a replay never rewrites the names');
  assert.equal(app.store.onboarding().completedAt, finishedAt);
  // The first pages opened: the name's origin story and the first meeting.
  const { readProfileDocument } = await import('../src/server/profile/profile.js');
  const identity = readProfileDocument(d, 'identity').content ?? '';
  assert.match(identity, /守灯塔/);
  assert.match(identity, /第一次见面/);
  assert.match(identity, /写一本小说/);
  const memory = readProfileDocument(d, 'memory').content;
  // Memory stays empty on day one: facts come from conversations, not setup.
  assert.equal(memory, null);
  await app.close();
});

test('finish never overwrites a hand-written identity file', async () => {
  const d = dir();
  const { writeProfileDocument } = await import('../src/server/profile/profile.js');
  writeProfileDocument(d, 'identity', '# 手写的我', null);

  const app = new App(d, () => {});
  await app.finishOnboarding({
    alias: '阿梁', companionName: '灯守', nameOrigin: '来自小说', notes: '', comfort: 'depends', rhythm: 'anytime',
  });
  const { readProfileDocument } = await import('../src/server/profile/profile.js');
  assert.equal(readProfileDocument(d, 'identity').content, '# 手写的我');
  // Onboarding still closed: a hand-written file is not a reason to loop.
  assert.notEqual(app.store.onboarding().completedAt, null);
  await app.close();
});
