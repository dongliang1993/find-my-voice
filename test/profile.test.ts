import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystemPrompt, personaVersion, readProfileDocument, writeProfileDocument } from '../src/server/profile/profile.js';

const dir = () => mkdtempSync(join(tmpdir(), 'fmv-profile-'));

test('reads a missing document as empty', () => {
  const doc = readProfileDocument(dir(), 'memory');
  assert.equal(doc.content, null);
  assert.equal(doc.sha256, null);
});

test('writes, then refuses a stale base hash', () => {
  const d = dir();
  const first = writeProfileDocument(d, 'identity', '# 我\n温柔、爱开玩笑', null);
  assert.equal(readProfileDocument(d, 'identity').content, '# 我\n温柔、爱开玩笑');
  assert.throws(() => writeProfileDocument(d, 'identity', '# 我\n高冷', null), /已变化/);
  writeProfileDocument(d, 'identity', '# 我\n高冷', first.sha256);
  assert.equal(readProfileDocument(d, 'identity').content, '# 我\n高冷');
});

test('backs up the previous version on overwrite', () => {
  const d = dir();
  const first = writeProfileDocument(d, 'memory', '- 喜欢猫', null);
  writeProfileDocument(d, 'memory', '- 喜欢猫\n- 怕黑', first.sha256);
  assert.equal(readdirSync(join(d, 'profile-history')).length, 1);
});

test('rejects empty or oversized content', () => {
  assert.throws(() => writeProfileDocument(dir(), 'memory', '   ', null), /正文/);
  assert.throws(() => writeProfileDocument(dir(), 'memory', 'x'.repeat(300 * 1024), null), /256 KiB/);
});

test('system prompt carries identity, memory and the companion name', () => {
  const d = dir();
  writeFileSync(join(d, 'IDENTITY.md'), '说话带点撒娇');
  writeFileSync(join(d, 'MEMORY.md'), '- 用户叫阿亮，程序员');
  const prompt = buildSystemPrompt(d, { companionName: '小月', now: new Date('2026-10-22T22:30:00+08:00') });
  assert.match(prompt, /小月/);
  assert.match(prompt, /说话带点撒娇/);
  assert.match(prompt, /阿亮/);
  assert.match(prompt, /send_voice/);
  assert.match(prompt, /2026/);
});

test('system prompt asks to get to know the user when there is no memory yet', () => {
  const prompt = buildSystemPrompt(dir(), { companionName: 'Vivi', now: new Date() });
  assert.match(prompt, /还不了解/);
});

test('persona version changes with memory, name or day, but not within the same day', () => {
  const d = dir();
  const morning = new Date(2026, 9, 22, 9), evening = new Date(2026, 9, 22, 22), tomorrow = new Date(2026, 9, 23, 9);
  const v1 = personaVersion(d, 'Vivi', morning);
  assert.equal(personaVersion(d, 'Vivi', evening), v1);
  assert.notEqual(personaVersion(d, 'Vivi', tomorrow), v1);
  assert.notEqual(personaVersion(d, '阿月', morning), v1);
  writeFileSync(join(d, 'MEMORY.md'), '- 叫阿亮');
  assert.notEqual(personaVersion(d, 'Vivi', morning), v1);
});
