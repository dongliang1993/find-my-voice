import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setup, entries, persona, memoryMarkdown, identityMarkdown, writeProfiles } from './helpers.js';
import { FixtureProvider } from '../src/provider.js';
import { projectRoot } from '../src/config.js';

test('setup derives resumable progress without saving, resetting or synthesizing', t => {
  let calls = 0;
  const x = setup({ async synthesize() { calls++; throw new Error('setup cannot generate audio'); } }); t.after(x.cleanup);
  const s = x.service;
  assert.equal(s.setup(true).data.ready, false); assert.equal(s.setup(true).data.next_step, 'memory');
  assert.equal(s.setup(true).data.memory_count, 0);
  const p = s.memorySave({ request_id: 'setup-memory-1', entries: [entries[0]] });
  const waiting = s.setup(true).data.steps.find(step => step.id === 'memory')!;
  assert.equal(waiting.state, 'current'); assert.equal(waiting.pending_id, undefined);
  s.decide(p.data.pending_id, false);
  assert.equal(s.setup(true).data.next_step, 'memory');
  const next = s.memorySave({ request_id: 'setup-memory-2', entries: [entries[0]] }); s.decide(next.data.pending_id, true);
  assert.equal(s.setup(true).data.next_step, 'memory'); assert.equal(s.setup(true).data.memory_count, 1);
  s.profileWrite({ document: 'memory', content: memoryMarkdown, base_sha256: null });
  assert.equal(s.setup(true).data.next_step, 'identity');
  assert.equal(calls, 0); assert.equal(s.store.export(s.config.ownerId).speeches.length, 0);
});

test('missing TTS credentials do not block grounded memories or identity; connection precedes paid audition', t => {
  let calls = 0;
  const x = setup({ async synthesize() { calls++; throw new Error('no paid calls during onboarding'); } }, { TTS_PROVIDER: 'volcengine' });
  t.after(x.cleanup); const s = x.service;
  const initial = s.setup(true).data;
  assert.equal(initial.next_step, 'memory');
  assert.deepEqual(initial.steps.map(step => step.id), ['memory', 'identity', 'connection', 'audition', 'voice']);
  assert.equal(initial.steps.find(step => step.id === 'connection')!.state, 'upcoming');
  assert.equal(initial.agent_handoff.target, 'current_conversation');
  assert.equal(initial.agent_handoff.automatic_draft, true);
  assert.equal(initial.agent_handoff.all_history_access, 'host_dependent');
  assert.equal(initial.agent_handoff.document_review, 'normal_host_file_permissions');
  assert.equal(s.context().memories.length, 0);
  s.profileWrite({ document: 'memory', content: memoryMarkdown, base_sha256: null });
  assert.equal(s.setup(true).data.next_step, 'identity');
  s.profileWrite({ document: 'identity', content: identityMarkdown, base_sha256: null });
  assert.equal(s.context().identity.identity, null);
  assert.equal(s.setup(true).data.next_step, 'connection');
  assert.equal(s.setup(true).data.steps.find(step => step.id === 'connection')!.state, 'blocked');
  assert.equal(s.setup(true).data.steps.find(step => step.id === 'audition')!.state, 'upcoming');
  assert.equal(calls, 0);
});

test('API key alone exposes a bundled audition candidate without manual resource or speaker setup', t => {
  const x = setup(undefined, { TTS_PROVIDER: 'volcengine', VOLC_API_KEY: 'candidate-test-key' }); t.after(x.cleanup);
  const state = x.service.setup(true).data;
  assert.equal(state.provider_configured, true);
  assert.equal(state.connection.account_permissions_verified, false);
  const voices = x.service.voiceList({}).data.voices;
  assert.ok(voices.length > 0);
  assert.equal(voices[0]!.resource_id, 'seed-tts-2.0');
  assert.equal(x.service.context().identity.voice, null);
  assert.equal(x.service.store.export(x.config.ownerId).speeches.length, 0);
  // A private allowlist still overrides public candidates, including an intentionally empty list.
  writeFileSync(resolve(x.dir, 'voices.json'), '[]');
  assert.equal(x.service.setup(true).data.provider_configured, false);
  assert.deepEqual(x.service.voiceList({}).data.voices, []);
});

test('an existing known bootstrap voice retains its catalog resource when only the key is configured', t => {
  const x = setup(undefined, { TTS_PROVIDER: 'volcengine', VOLC_API_KEY: 'candidate-test-key',
    VOLC_DEFAULT_VOICE: 'zh_female_vv_uranus_bigtts' }); t.after(x.cleanup);
  assert.equal(x.service.setup(true).data.provider_configured, true);
  assert.equal(x.service.voiceList({}).data.voices[0]!.resource_id, 'seed-tts-2.0');
});

test('bootstrap audio cannot finish setup; grounded identity, audition and voice each require their own effective state', async t => {
  const fixture = new FixtureProvider();
  const x = setup({ synthesize: input => fixture.synthesize(input) }, {
    TTS_PROVIDER: 'volcengine', VOLC_API_KEY: 'setup-test-key', VOLC_RESOURCE_ID: 'seed-tts-2.0', VOLC_DEFAULT_VOICE: 'test-speaker',
  }); t.after(x.cleanup); const s = x.service;
  await s.speak({ request_id: 'setup-bootstrap-1', text: '测试数据，不是真实 TTS。', playback: 'none' }, true);
  assert.equal(s.setup(true).data.sample_ids.length, 0); assert.equal(s.setup(true).data.ready, false);
  const memory = s.memorySave({ request_id: 'setup-memory-3', entries: [entries[0]] }); s.decide(memory.data.pending_id, true);
  const memoryIds = s.context().memories.map(m => m.id);
  const identity = s.identityUpdate({ request_id: 'setup-identity-1', base_version: 0, identity: persona, memory_ids: memoryIds, change_reason: '依据确认记忆建立测试画像。' });
  s.decide(identity.data.pending_id, true);
  writeProfiles(s);
  assert.equal(s.setup(true).data.next_step, 'audition');
  await s.speak({ request_id: 'setup-audition-1', text: '测试数据，不是真实 TTS。', playback: 'none' }, true);
  assert.equal(s.setup(true).data.next_step, 'voice');
  const voice = s.identityUpdate({ request_id: 'setup-voice-1', base_version: 1, change_reason: '测试选声。', voice: {
    voice_id: 'test-speaker', reason: '依据测试画像。', assessment_basis: 'description', evidence: ['测试目录'],
  } });
  assert.equal(s.setup(true).data.ready, false);
  s.decide(voice.data.pending_id, true);
  assert.deepEqual(s.context().identity.memory_ids, memoryIds);
  assert.equal(s.setup(true).data.ready, true); assert.equal(s.setup(true).data.next_step, 'ready');
  assert.equal(s.setup(false).data.playback.target, 'browser'); assert.equal(s.setup(false).data.playback.automatic_playback_verified, false);
  assert.ok(!JSON.stringify(s.setup(true)).includes('setup-test-key'));
  s.store.deactivateMemory(s.config.ownerId, memoryIds[0]!);
  assert.equal(s.setup(true).data.ready, true); // Legacy SQL evidence is no longer the document authority.
  const profile = s.context().profile_documents;
  s.profileWrite({ document: 'identity', content: identityMarkdown + '\n## 修订\n新增测试判断。\n', base_sha256: profile.identity.sha256 });
  assert.equal(s.setup(true).data.ready, false);
});

test('workspace installation registers three relocatable skills, backs up unrelated config and is idempotent', t => {
  const x = setup(); t.after(x.cleanup);
  const target = resolve(x.dir, 'workspace'); const cfg = resolve(target, '.codex/config.toml');
  mkdirSync(resolve(target, '.codex'), { recursive: true });
  const original = '[mcp_servers.other]\ncommand = "other-server"\n'; writeFileSync(cfg, original);
  const args = [resolve(projectRoot, 'scripts/setup-codex.mjs'), '--workspace', target];
  execFileSync(process.execPath, args, { stdio: 'pipe' });
  const first = readFileSync(cfg, 'utf8'); assert.ok(first.includes(original.trim()));
  const backups = readdirSync(resolve(target, '.codex')).filter(name => name.endsWith('.bak'));
  assert.equal(backups.length, 1); assert.equal(readFileSync(resolve(target, '.codex', backups[0]!), 'utf8'), original);
  for (const skill of ['finding-my-voice-setup', 'identity-evolution', 'voice-expression']) {
    assert.equal(realpathSync(resolve(target, '.agents/skills', skill)), realpathSync(resolve(projectRoot, 'skills', skill)));
  }
  execFileSync(process.execPath, args, { stdio: 'pipe' });
  assert.equal(readFileSync(cfg, 'utf8'), first);
  assert.equal(readdirSync(resolve(target, '.codex')).filter(name => name.endsWith('.bak')).length, 1);
  assert.ok(existsSync(resolve(projectRoot, 'dist/stdio.js')));
});
