import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractSetupProfile, authorizedHistoryFiles } from '../src/onboarding.js';
import { setup, memoryMarkdown, identityMarkdown, writeProfiles } from './helpers.js';

const extraction = () => ({ memory_markdown: memoryMarkdown, identity_markdown: identityMarkdown,
  sources_read: ['显式测试会话'], coverage_limits: ['仅隔离测试材料，不是用户真实历史。'], conflicts: [] });

test('legacy documents require setup migration, but status never deletes or rewrites them', t => {
  const x = setup(); t.after(x.cleanup);
  x.service.profileWrite({ document: 'memory', content: '# 旧资料\n旧个人事实。\n', base_sha256: null });
  x.service.profileWrite({ document: 'identity', content: '# 旧画像\n已有形象：蓝色纸鹤。\n', base_sha256: null });
  const before = x.service.context().profile_documents;
  assert.equal(before.ready, true); assert.equal(before.layout.ready, false);
  assert.equal(x.service.setup(true).data.next_step, 'memory');
  assert.equal(readFileSync(before.identity.path, 'utf8'), before.identity.content);
  assert.equal(x.service.context().profile_documents.fingerprint, before.fingerprint);
});

test('headless setup supplies existing image, runtime voice and explicit sources, then saves two private blocks', async t => {
  const x = setup(undefined, { VOLC_API_KEY: 'test-secret-not-for-ai' }); t.after(x.cleanup); writeProfiles(x.service);
  const source = resolve(x.dir, 'host-memory.md'); writeFileSync(source, '仅测试：2026-01-01 喜欢汉堡；2026-02-01 改为不喜欢汉堡。');
  const voice = x.service.identityUpdate({ request_id: 'retain-existing-voice', base_version: 0, change_reason: '测试已有声音。', voice: {
    voice_id: 'fixture-tone', reason: '测试已有配置。', assessment_basis: 'description', evidence: ['测试材料'] } });
  x.service.decide(voice.data.pending_id, true);
  const existingVoice = x.service.context().identity.voice;
  const result = await extractSetupProfile(x.service, { sources: [source, source] }, async input => {
    const supplied = JSON.parse(input.prompt.split('输入数据 JSON：\n')[1]!);
    assert.equal(supplied.existing_documents.identity, identityMarkdown);
    assert.deepEqual(supplied.authorized_source_files, [realpathSync(source)]);
    assert.ok(input.prompt.includes('fixture-tone'));
    assert.ok(input.prompt.includes('当前有效记忆'));
    assert.ok(input.prompt.includes('不自动继承'));
    assert.ok(!input.prompt.includes(x.config.volc.apiKey));
    const schema = JSON.parse(readFileSync(input.schemaPath, 'utf8'));
    assert.equal(schema.additionalProperties, false);
    return extraction();
  });
  assert.equal(result.status, 'completed');
  assert.equal(x.service.context().profile_documents.layout.ready, true);
  assert.deepEqual(x.service.context().identity.voice, existingVoice);
  assert.equal(x.service.store.export(x.config.ownerId).speeches.length, 0);
  assert.equal(statSync(result.request_path).mode & 0o777, 0o600);
  assert.equal(statSync(resolve(x.dir, 'MEMORY.md')).mode & 0o777, 0o600);
});

test('invalid AI output is rejected before either existing document can change', async t => {
  const x = setup(); t.after(x.cleanup); writeProfiles(x.service);
  const before = x.service.context().profile_documents;
  for (const output of [{ ...extraction(), identity_markdown: '# 人格\n没有分块。' }, { ...extraction(), memory_markdown: memoryMarkdown + '\0' }, { incomplete: true }]) {
    await assert.rejects(extractSetupProfile(x.service, { sources: [] }, async () => output), /未保存/);
    assert.equal(x.service.context().profile_documents.fingerprint, before.fingerprint);
  }
  assert.equal(existsSync(resolve(x.dir, 'profile-history')), false);
});

test('prepare-only fallback writes a request but never starts an AI or changes profiles', async t => {
  const x = setup(); t.after(x.cleanup);
  const source = resolve(x.dir, 'authorized.json'); writeFileSync(source, '{"messages":[]}');
  let calls = 0;
  const result = await extractSetupProfile(x.service, { sources: [source], prepareOnly: true }, async () => { calls++; return extraction(); });
  assert.equal(result.status, 'request_prepared'); assert.equal(calls, 0);
  assert.equal(x.service.context().profile_documents.ready, false);
  assert.equal(existsSync(resolve(x.dir, 'MEMORY.md')), false);
  assert.ok(readFileSync(result.request_path, 'utf8').includes(source));
});

test('concurrent edits during AI extraction are never overwritten', async t => {
  const x = setup(); t.after(x.cleanup); writeProfiles(x.service);
  const before = x.service.context().profile_documents;
  const edited = memoryMarkdown + '\n用户在提取期间补充的真实资料。\n';
  await assert.rejects(extractSetupProfile(x.service, { sources: [] }, async () => {
    x.service.profileWrite({ document: 'memory', content: edited, base_sha256: before.memory.sha256 });
    return extraction();
  }), /提取期间资料已变化/);
  assert.equal(x.service.context().profile_documents.memory.content, edited);
  assert.equal(x.service.context().profile_documents.identity.sha256, before.identity.sha256);
});

test('no-source initialization, credential files and directories cannot become implicit history', async t => {
  const x = setup(); t.after(x.cleanup);
  let calls = 0;
  await assert.rejects(extractSetupProfile(x.service, { sources: [] }, async () => { calls++; return extraction(); }), /不自动继承云端历史/);
  assert.equal(calls, 0);
  assert.throws(() => authorizedHistoryFiles([x.dir]), /不能是目录/);
  const secret = resolve(x.dir, '.env'); writeFileSync(secret, 'NOT_A_REAL_SECRET=test');
  assert.throws(() => authorizedHistoryFiles([secret]), /凭证/);
  assert.equal(readdirSync(x.dir).includes('setup-runs'), false);
});

test('empty or code-example headings cannot falsely finish identity setup', t => {
  const x = setup(); t.after(x.cleanup);
  x.service.profileWrite({ document: 'memory', content: memoryMarkdown, base_sha256: null });
  for (const content of ['# 画像\n\n## 个人形象\n## 性格与关系\n## 声音\n## 演化记录\n只有一块有正文。', '```md\n' + identityMarkdown + '\n```\n仅为格式示例。']) {
    const old = x.service.context().profile_documents.identity;
    x.service.profileWrite({ document: 'identity', content, base_sha256: old.sha256 });
    assert.equal(x.service.setup(true).data.next_step, 'identity');
  }
});
