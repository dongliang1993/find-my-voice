import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectRoot } from '../src/config.js';

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
