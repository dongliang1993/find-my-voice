import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { setup, entries, persona } from './helpers.js';
import { DomainError } from '../src/errors.js';
import { FixtureProvider } from '../src/provider.js';
import { VoiceService } from '../src/service.js';

test('memory proposals remain ineffective until a scoped user decision; partial confirmation and idempotency', t => {
  const { service: s, cleanup } = setup(); t.after(cleanup);
  const input = { request_id: 'memory-request-1', entries };
  const result = s.memorySave(input); assert.equal(result.status, 'awaiting_confirmation'); assert.equal(s.context().memories.length, 0);
  assert.throws(() => s.store.pending('different-owner', result.data.pending_id), /不存在/);
  assert.throws(() => s.decide(result.data.pending_id, true, [99]), /有效/);
  s.decide(result.data.pending_id, true, [0]); assert.equal(s.context().memories.length, 1);
  assert.deepEqual((s.memorySave(input).data as Record<string, unknown>).memory_ids, s.context().memories.map(m => m.id));
  assert.equal(s.memorySave(input).status, 'approved');
  assert.throws(() => s.memorySave({ ...input, entries: [entries[1]] }), (e: unknown) => e instanceof DomainError && e.code === 'REQUEST_CONFLICT');
  const again = s.memorySave({ ...input, request_id: 'memory-request-2', entries: [entries[0]] }); s.decide(again.data.pending_id, true);
  assert.equal(s.context().memories.length, 1);
});
test('a model-supplied confirmation flag cannot bypass the separate decision channel', t => {
  const { service: s, cleanup } = setup(); t.after(cleanup);
  assert.throws(() => s.memorySave({ request_id: 'memory-request-3', entries, confirmed: true }));
  assert.equal(s.context().memories.length, 0);
});
test('rejection leaves effective identity unchanged and replays return rejected', t => {
  const { service: s, cleanup } = setup(); t.after(cleanup);
  const input = { request_id: 'identity-request-1', base_version: 0, identity: persona, change_reason: '初始测试画像。' };
  const result = s.identityUpdate(input); s.decide(result.data.pending_id, false);
  assert.equal(s.context().identity.version, 0); assert.equal(s.identityUpdate(input).status, 'rejected');
});
test('concurrent persona drafts enforce base version at confirmation, keep history and voice configuration', t => {
  const { service: s, cleanup } = setup(); t.after(cleanup);
  const draft = (request_id: string) => s.identityUpdate({ request_id, base_version: 0, identity: persona, change_reason: '初始测试画像。' });
  const a = draft('identity-request-2'), b = draft('identity-request-3'); s.decide(a.data.pending_id, true);
  assert.throws(() => s.decide(b.data.pending_id, true), (e: unknown) => e instanceof DomainError && e.code === 'VERSION_CONFLICT');
  const voice = s.identityUpdate({ request_id: 'identity-request-4', base_version: 1, change_reason: '测试选择。', voice: {
    voice_id: 'fixture-tone', reason: '测试链路。', assessment_basis: 'description', evidence: ['测试标签'], speech_rate: 5, loudness_rate: 0,
  } }); s.decide(voice.data.pending_id, true);
  assert.equal(s.context().identity.version, 2); assert.equal(s.context().identity.voice?.speech_rate, 5);
  assert.equal(s.store.export(s.config.ownerId).identity_versions.length, 2);
});
test('memory references must exist and a prompt-designed sample cannot become a persistent speaker', t => {
  const { service: s, cleanup } = setup(); t.after(cleanup);
  assert.throws(() => s.identityUpdate({ request_id: 'identity-request-5', base_version: 0, identity: persona, change_reason: '测试。', memory_ids: ['00000000-0000-4000-8000-000000000001'] }), /记忆/);
  assert.throws(() => s.identityUpdate({ request_id: 'identity-request-6', base_version: 0, identity: persona, change_reason: '测试。', voice: {
    voice_id: 'designed-voice', reason: '纯描述样本', assessment_basis: 'description', evidence: ['描述'],
  } }), /未加入/);
});
test('paid synthesis deduplicates concurrent and replayed requests without changing persona', async t => {
  let calls = 0; const fixture = new FixtureProvider();
  const { service: s, cleanup } = setup({ synthesize: async input => { calls++; await new Promise(r => setTimeout(r, 10)); return fixture.synthesize(input); } }); t.after(cleanup);
  const input = { request_id: 'speech-request-1', text: '测试一句话。' };
  const [a, b] = await Promise.all([s.speak(input, true), s.speak(input, true)]);
  assert.equal(calls, 1); assert.equal(a.data.audio_id, b.data.audio_id); assert.ok(existsSync(a.data.local_audio_path!));
  const replay = await s.speak(input); assert.equal(replay.data.reused, true); assert.equal(calls, 1);
  assert.equal(s.context().identity.version, 0); assert.equal(s.context().identity.voice, null);
  await assert.rejects(s.speak({ ...input, text: '不同的台词。' }), (e: unknown) => e instanceof DomainError && e.code === 'REQUEST_CONFLICT');
});
test('unknown generation does not retry and long text is not silently truncated', async t => {
  let calls = 0;
  const { service: s, cleanup } = setup({ synthesize: async () => { calls++; throw new DomainError('TTS_TIMEOUT', '测试超时。'); } }); t.after(cleanup);
  const input = { request_id: 'speech-request-2', text: '测试。' };
  await assert.rejects(s.speak(input)); await assert.rejects(s.speak(input)); assert.equal(calls, 1);
  assert.equal(s.store.speechByRequest(s.config.ownerId, input.request_id)?.state, 'unknown');
  await assert.rejects(s.speak({ request_id: 'speech-request-3', text: '字'.repeat(501) }), (e: unknown) => e instanceof DomainError && e.code === 'TEXT_TOO_LONG');
});
test('expired audio is removed and the original request does not regenerate it', async t => {
  const { service: s, cleanup } = setup(); t.after(cleanup);
  const input = { request_id: 'speech-request-4', text: '测试。' }; const result = await s.speak(input, true);
  s.store.db.prepare('UPDATE speeches SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1).toISOString(), result.data.audio_id);
  s.assets.cleanup(); assert.equal(existsSync(result.data.local_audio_path!), false);
  await assert.rejects(s.speak(input)); assert.equal(s.store.speechByRequest(s.config.ownerId, input.request_id)?.state, 'expired');
});
test('completed data survives reopening SQLite', async t => {
  const x = setup(); t.after(x.cleanup);
  const p = x.service.memorySave({ request_id: 'memory-request-4', entries: [entries[0]] }); x.service.decide(p.data.pending_id, true);
  const second = new VoiceService(x.config); t.after(() => second.close());
  assert.equal(second.context().memories.length, 1);
});
test('a new real-provider service fails clearly without credentials, never synthesizes a fixture', async t => {
  const { service: s, cleanup } = setup(undefined, { TTS_PROVIDER: 'volcengine', VOLC_DEFAULT_VOICE: 'zh_female_vv_uranus_bigtts' }); t.after(cleanup);
  await assert.rejects(s.speak({ request_id: 'speech-request-5', text: '测试。' }), (e: unknown) => e instanceof DomainError && e.code === 'SETUP_REQUIRED');
  assert.equal(s.store.export(s.config.ownerId).speeches.length, 0);
});
