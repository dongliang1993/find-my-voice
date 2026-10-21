import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectRoot } from '../src/config.js';
import { testEnv } from './helpers.js';

function isolatedSetup(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(resolve(tmpdir(), 'find-my-voice-setup-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const folder of ['scripts', 'dist']) mkdirSync(resolve(dir, folder));
  symlinkSync(resolve(projectRoot, 'node_modules'), resolve(dir, 'node_modules'), 'dir');
  for (const file of ['scripts/setup-local.mjs', 'dist/cli-api.js', 'voices.example.json']) copyFileSync(resolve(projectRoot, file), resolve(dir, file));
  const envFile = resolve(dir, '.env');
  const content = Object.entries({ ...testEnv, TTS_PROVIDER: 'volcengine', VOLC_API_KEY: '', VOLC_RESOURCE_ID: '', VOLC_DEFAULT_VOICE: '' })
    .map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
  writeFileSync(envFile, content, { mode: 0o600 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(VOLC_|TTS_|SEED_AUDIO_|VOICE_|LOCAL_AUDIO_|DATA_DIR$|PLUGIN_DATA$|OWNER_ID$|ADMIN_TOKEN$|MCP_TOKEN$|MEDIA_SIGNING_KEY$|PUBLIC_BASE_URL$)/.test(key)));
  const run = (args: string[]) => spawnSync(process.execPath, [resolve(dir, 'scripts/setup-local.mjs'), ...args], { cwd: dir, env, encoding: 'utf8', timeout: 10000 });
  return { dir, envFile, content, run };
}

test('default setup hands off to the current conversation without prompting or changing credentials', t => {
  const x = isolatedSetup(t);
  const result = x.run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(x.envFile, 'utf8'), x.content);
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
  const updated = readFileSync(x.envFile, 'utf8');
  assert.ok(updated.includes('VOLC_API_KEY=import-test-key\n'));
  assert.ok(updated.includes(`OWNER_ID=${testEnv.OWNER_ID}\n`));
  assert.ok(updated.includes('VOICE_REPLY_MODE=explicit\n'));
  assert.ok(updated.includes('VOLC_DEFAULT_VOICE_NAME="My Voice"\n'));
  assert.ok(!updated.includes('do-not-copy'));
  assert.equal(statSync(x.envFile).mode & 0o777, 0o600);
  const state = JSON.parse(x.run(['--json']).stdout);
  assert.equal(state.provider_configured, true);
  assert.equal(state.memory_count, 0); assert.equal(state.identity_version, 0);
  assert.deepEqual(state.sample_ids, []);
});

test('explicit legacy credential import replaces a previous API key without leaking either credential', t => {
  const x = isolatedSetup(t); const source = resolve(x.dir, 'legacy-private.env');
  writeFileSync(x.envFile, x.content.replace('VOLC_API_KEY=\n', 'VOLC_API_KEY=previous-test-key\n'));
  writeFileSync(source, 'VOLC_APP_ID=legacy-test-app\nVOLC_ACCESS_KEY=legacy-test-key\n');
  const result = x.run(['--import-config', source]);
  assert.equal(result.status, 0, result.stderr);
  const updated = readFileSync(x.envFile, 'utf8');
  assert.ok(updated.includes('VOLC_API_KEY=\n'));
  assert.ok(updated.includes('VOLC_APP_ID=legacy-test-app\n'));
  assert.ok(!result.stdout.includes('legacy-test-key'));
  assert.equal(JSON.parse(x.run(['--json']).stdout).provider_configured, true);
});

test('read-only JSON rejects credential mutations and Agent launch; missing credentials never prompt on a pipe', t => {
  const x = isolatedSetup(t);
  for (const args of [['--json', '--connect'], ['--json', '--agent', 'codex'], ['--advanced'], ['--connect'], ['--import-config']]) {
    const result = x.run(args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(readFileSync(x.envFile, 'utf8'), x.content);
  }
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
