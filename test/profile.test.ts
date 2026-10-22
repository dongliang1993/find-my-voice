import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { setup, entries, memoryMarkdown, identityMarkdown, writeProfiles } from './helpers.js';
import { createMcpServer } from '../src/mcp.js';
import { FixtureProvider } from '../src/provider.js';
import { DomainError } from '../src/errors.js';
import { VoiceService } from '../src/service.js';

test('reading setup does not create placeholder documents; host writes two independent Markdown sources', t => {
  const x = setup(); t.after(x.cleanup); const s = x.service;
  const initial = s.setup(true).data.profile_documents;
  assert.equal(initial.ready, false); assert.equal(existsSync(initial.memory.path), false);
  const rejected = s.memorySave({ request_id: 'old-rejected-draft', entries: [entries[0]] }); s.decide(rejected.data.pending_id, false);
  writeProfiles(s);
  const context = s.context();
  assert.equal(context.profile_documents.ready, true);
  assert.equal(context.profile_documents.memory.content, memoryMarkdown);
  assert.equal(context.profile_documents.identity.content, identityMarkdown);
  assert.equal(context.memories.length, 0); assert.equal(context.identity.identity, null);
  assert.equal(s.setup(true).data.next_step, 'connection');
  assert.equal(statSync(initial.memory.path).mode & 0o777, 0o600);
  const second = new VoiceService(x.config); t.after(() => second.close());
  assert.equal(second.context().profile_documents.fingerprint, context.profile_documents.fingerprint);
});

test('document edits use optimistic concurrency and private backups; direct host edits are read live', t => {
  const x = setup(); t.after(x.cleanup); writeProfiles(x.service);
  const before = x.service.context().profile_documents;
  const updatedText = memoryMarkdown + '\n## M-002 新证据\n来源：新增测试材料。\n';
  const update = x.service.profileWrite({ document: 'memory', content: updatedText, base_sha256: before.memory.sha256 });
  assert.equal(readFileSync(update.data.document.backup_path!, 'utf8'), memoryMarkdown);
  assert.equal(statSync(update.data.document.backup_path!).mode & 0o777, 0o600);
  assert.throws(() => x.service.profileWrite({ document: 'memory', content: '不能覆盖新内容。', base_sha256: before.memory.sha256 }),
    (e: unknown) => e instanceof DomainError && e.code === 'PROFILE_CONFLICT');
  assert.throws(() => x.service.profileWrite({ document: 'memory', content: '不能用新建模式覆盖。', base_sha256: null }));
  const current = x.service.context().profile_documents;
  assert.equal(current.memory.content, updatedText);
  assert.notEqual(current.fingerprint, before.fingerprint);
  const unchanged = x.service.profileWrite({ document: 'memory', content: updatedText, base_sha256: current.memory.sha256 });
  assert.equal(unchanged.data.document.changed, false);
  writeFileSync(before.identity.path, identityMarkdown + '\n## 宿主手动修订\n增加新的测试依据。\n');
  assert.ok(x.service.context().profile_documents.identity.content!.includes('宿主手动修订'));
});

test('profile files reject empty templates, invalid paths, oversized content and symlink targets', t => {
  const x = setup(); t.after(x.cleanup);
  for (const content of ['# 只有标题\n', '<!-- 注释 -->', 'x\0y', '字'.repeat(100000)]) {
    assert.throws(() => x.service.profileWrite({ document: 'memory', content, base_sha256: null }));
  }
  assert.throws(() => x.service.profileWrite({ document: '../private', content: '测试。', base_sha256: null }));
  const outside = resolve(x.dir, 'unrelated.txt'); writeFileSync(outside, 'do not read or overwrite');
  symlinkSync(outside, resolve(x.dir, 'MEMORY.md'));
  assert.equal(x.service.context().profile_documents.memory.content, null);
  assert.throws(() => x.service.profileWrite({ document: 'memory', content: memoryMarkdown, base_sha256: null }));
  assert.equal(readFileSync(outside, 'utf8'), 'do not read or overwrite');
});

test('MCP profile writes do not elicit nested approvals and Markdown resources immediately reflect the saved text', async t => {
  const x = setup(); const server = createMcpServer(x.service, true);
  const client = new Client({ name: 'document-host', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  let forms = 0;
  client.setRequestHandler(ElicitRequestSchema, async () => { forms++; return { action: 'decline' }; });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); x.cleanup(); });
  await server.connect(st); await client.connect(ct);
  for (const [document, content] of [['memory', memoryMarkdown], ['identity', identityMarkdown]]) {
    const result = await client.callTool({ name: 'profile.write', arguments: { document, content, base_sha256: null } });
    assert.equal((result.structuredContent as { status: string }).status, 'completed');
  }
  const memory = await client.readResource({ uri: 'finding-my-voice://profile/memory' });
  assert.equal(memory.contents[0]!.mimeType, 'text/markdown');
  assert.ok('text' in memory.contents[0]!);
  assert.equal(memory.contents[0]!.text, memoryMarkdown);
  assert.equal(forms, 0); assert.equal(x.service.context().profile_documents.ready, true);
  assert.equal(x.service.store.pendingList(x.config.ownerId).length, 0);
});

test('document-only onboarding can audition and confirm a voice without SQL memory or persona approval', async t => {
  const fixture = new FixtureProvider();
  const x = setup({ synthesize: input => fixture.synthesize(input) }, { TTS_PROVIDER: 'volcengine', VOLC_API_KEY: 'test-document-key',
    VOLC_DEFAULT_VOICE: 'test-speaker', VOLC_RESOURCE_ID: 'seed-tts-2.0' }); t.after(x.cleanup);
  const s = x.service;
  await s.speak({ request_id: 'before-profile-audio', text: '资料生成前的测试。', playback: 'none' }, true);
  writeProfiles(s);
  assert.equal(s.setup(true).data.next_step, 'audition'); assert.deepEqual(s.setup(true).data.sample_ids, []);
  const audio = await s.speak({ request_id: 'document-based-audio', text: '依据文档的测试试听。', playback: 'none' }, true);
  assert.equal(audio.data.identity_version, 0);
  assert.equal(audio.data.profile_hash, s.context().profile_documents.fingerprint);
  assert.equal(s.setup(true).data.next_step, 'voice');
  const voice = s.identityUpdate({ request_id: 'document-voice-choice', base_version: 0, change_reason: '基于两份文档选择声音。', voice: {
    voice_id: 'test-speaker', reason: '依据 MEMORY.md 与 IDENTITY.md。', assessment_basis: 'description', evidence: ['测试资料'] } });
  assert.equal(voice.status, 'awaiting_confirmation'); assert.equal(s.setup(true).data.ready, false);
  s.decide(voice.data.pending_id, true);
  assert.equal(s.setup(true).data.ready, true); assert.equal(s.context().identity.identity, null);
  assert.equal(s.context().memories.length, 0); assert.equal(s.context().identity.voice!.voice_id, 'test-speaker');
});

test('changing a profile document invalidates a pending voice decision, never silently overwrites it', t => {
  const x = setup(); t.after(x.cleanup); writeProfiles(x.service); const s = x.service;
  const voice = s.identityUpdate({ request_id: 'profile-change-voice', base_version: 0, change_reason: '测试声音。', voice: {
    voice_id: 'fixture-tone', reason: '测试依据。', assessment_basis: 'description', evidence: ['测试资料'] } });
  const profile = s.context().profile_documents;
  s.profileWrite({ document: 'identity', content: identityMarkdown + '\n新的表达原则。\n', base_sha256: profile.identity.sha256 });
  assert.throws(() => s.decide(voice.data.pending_id, true), (e: unknown) => e instanceof DomainError && e.code === 'PROFILE_CONFLICT');
  assert.equal(s.context().identity.voice, null);
  assert.equal(s.store.pending(s.config.ownerId, voice.data.pending_id).state, 'pending');
});

test('an older SQLite audio table receives the profile hash column without losing existing audio records', async t => {
  const x = setup(); t.after(x.cleanup);
  const audio = await x.service.speak({ request_id: 'old-database-audio', text: '旧记录。' });
  x.service.store.db.exec('ALTER TABLE speeches DROP COLUMN profile_hash');
  const second = new VoiceService(x.config); t.after(() => second.close());
  assert.equal(second.store.speech(x.config.ownerId, audio.data.audio_id).state, 'completed');
  assert.equal(second.store.speech(x.config.ownerId, audio.data.audio_id).profile_hash, null);
});
