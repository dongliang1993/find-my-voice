import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectRoot } from '../src/config.js';


function isolatedSetup(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(resolve(tmpdir(), 'find-my-voice-setup-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const folder of ['scripts', 'dist']) mkdirSync(resolve(dir, folder));
  symlinkSync(resolve(projectRoot, 'node_modules'), resolve(dir, 'node_modules'), 'dir');
  for (const file of ['scripts/setup-local.mjs', 'dist/cli-api.js', 'voices.example.json']) copyFileSync(resolve(projectRoot, file), resolve(dir, file));
  // settings.json is the only config input now; the CLI creates it on demand.
  const env = { ...process.env, PLUGIN_DATA: resolve(dir, 'data'), PATH: process.env.PATH || '' };
  const run = (args: string[]) => spawnSync(process.execPath, [resolve(dir, 'scripts/setup-local.mjs'), ...args], { cwd: dir, env, encoding: 'utf8', timeout: 10000 });
  return { dir, env, run };
}

test('default setup hands off to the current conversation without prompting or changing credentials', t => {
  const x = isolatedSetup(t);
  const result = x.run([]);
  assert.equal(result.status, 0, result.stderr);
  const json = x.run(['--json']);
  assert.equal(json.status, 0, json.stderr);
  const state = JSON.parse(json.stdout);
  assert.equal(state.next_step, 'memory');
  assert.equal(state.provider_configured, false);
  assert.equal(state.agent_handoff.target, 'current_conversation');
  assert.equal(state.paid_audio_generated, false);
});

test('explicit import reuses only provider credentials and preserves private identity, mode and data path', t => {
  const x = isolatedSetup(t); const source = resolve(x.dir, 'existing-private.env');
  writeFileSync(source, 'VOLC_API_KEY=import-test-key\nVOLC_DEFAULT_VOICE_NAME="My Voice"\nADMIN_TOKEN=do-not-copy\nOWNER_ID=other-owner\nDATA_DIR=/do-not-copy\nVOICE_REPLY_MODE=adaptive\n');
  const result = x.run(['--import-config', source]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes('import-test-key'));
  // The CLI now writes settings.json, not .env, and only the provider group.
  const updated = JSON.parse(readFileSync(resolve(x.dir, 'data/settings.json'), 'utf8'));
  assert.equal(updated.provider.apiKey, 'import-test-key');
  assert.equal(updated.provider.defaultVoiceName, 'My Voice');
  assert.equal(updated.provider.type, 'volcengine');
  assert.equal(updated.voice.replyMode, 'explicit');
  assert.ok(!JSON.stringify(updated).includes('do-not-copy'));
  assert.equal(statSync(resolve(x.dir, 'data/settings.json')).mode & 0o777, 0o600);
  const state = JSON.parse(x.run(['--json']).stdout);
  assert.equal(state.provider_configured, true);
  assert.equal(state.memory_count, 0); assert.equal(state.identity_version, 0);
  assert.deepEqual(state.sample_ids, []);
});

test('explicit legacy credential import replaces a previous API key without leaking either credential', t => {
  const x = isolatedSetup(t); const source = resolve(x.dir, 'legacy-private.env');
  writeFileSync(resolve(x.dir, 'first.env'), 'VOLC_API_KEY=previous-test-key\n');
  x.run(['--import-config', resolve(x.dir, 'first.env')]);
  writeFileSync(source, 'VOLC_APP_ID=legacy-test-app\nVOLC_ACCESS_KEY=legacy-test-key\n');
  const result = x.run(['--import-config', source]);
  assert.equal(result.status, 0, result.stderr);
  const updated = JSON.parse(readFileSync(resolve(x.dir, 'data/settings.json'), 'utf8'));
  assert.equal(updated.provider.apiKey, '');
  assert.equal(updated.provider.appId, 'legacy-test-app');
  assert.ok(!result.stdout.includes('legacy-test-key'));
  assert.equal(JSON.parse(x.run(['--json']).stdout).provider_configured, true);
});

test('read-only JSON rejects credential mutations and Agent launch; missing credentials never prompt on a pipe', t => {
  const x = isolatedSetup(t);
  for (const args of [['--json', '--connect'], ['--json', '--agent', 'codex'], ['--json', '--agent', 'request'], ['--advanced'], ['--connect'], ['--import-config'], ['--agent'], ['--history'], ['--refresh-profile']]) {
    const result = x.run(args);
    assert.equal(result.status, 1, JSON.stringify(args));
  }
});

test('setup request fallback works without TTY or credentials and retains multiple explicit history files', t => {
  const x = isolatedSetup(t);
  mkdirSync(resolve(x.dir, 'skills/identity-evolution/references'), { recursive: true });
  copyFileSync(resolve(projectRoot, 'skills/identity-evolution/references/profile-format.md'), resolve(x.dir, 'skills/identity-evolution/references/profile-format.md'));
  const sources = [resolve(x.dir, 'session.json'), resolve(x.dir, 'native-memory.md')];
  writeFileSync(sources[0]!, '{"messages":[]}'); writeFileSync(sources[1]!, '仅测试材料。');
  const result = x.run(['--agent', 'request', ...sources.flatMap(path => ['--history', path])]);
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(x.run(['--json']).stdout);
  assert.equal(state.profile_documents.ready, false);
  assert.equal(state.next_step, 'memory');
  const request = result.stdout.match(/提取请求已准备：([^\n]+)/)![1]!;
  const content = readFileSync(request, 'utf8');
  for (const source of sources) assert.ok(content.includes(source));
  assert.equal(statSync(request).mode & 0o777, 0o600);
});

test('private setup updates only requested keys, preserves other configuration and rejects newline injection', () => {
  const script = pathToFileURL(resolve(projectRoot, 'scripts/setup-local.mjs')).href;
  const code = `import assert from 'node:assert/strict'; import { updatePrivateEnv } from ${JSON.stringify(script)};
    const original = '# private settings\\nVOLC_API_KEY=old-test-value\\nPORT=4321\\n';
    const updated = updatePrivateEnv(original, { VOLC_API_KEY: 'new-test-value', VOICE_REPLY_MODE: 'adaptive' });
    assert.ok(updated.includes('# private settings\\n'));
    assert.ok(updated.includes('PORT=4321\\n'));
    assert.ok(updated.includes('VOLC_API_KEY=new-test-value\\n'));
    assert.equal(updated.match(/VOLC_API_KEY=/g).length, 1);
    assert.throws(() => updatePrivateEnv(original, { VOLC_API_KEY: 'bad\\nINJECTED=yes' }));
    assert.throws(() => updatePrivateEnv(original, { 'BAD=KEY': 'value' }));
    console.log('passed');`;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' }).trim(), 'passed');
});

test('npx installer refuses a non-empty unrelated directory before installing or changing client settings', t => {
  if (process.platform !== 'darwin') return t.skip('macOS installer target');
  const dir = mkdtempSync(resolve(tmpdir(), 'find-my-voice-protected-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = resolve(dir, 'user-file.txt'); writeFileSync(file, 'keep my data');
  const result = spawnSync(process.execPath, [resolve(projectRoot, 'bin/find-my-voice.mjs'), 'install', '--install-dir', dir, '--client', 'manual'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /unrelated files/);
  assert.equal(readFileSync(file, 'utf8'), 'keep my data');
});
