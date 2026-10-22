import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, maskSettings, settingsPatchSchema, updateSettings } from '../src/server/config.js';

const tempDir = () => mkdtempSync(join(tmpdir(), 'fmv-config-'));

test('creates defaults on first run with private permissions', () => {
  const dir = tempDir();
  const settings = loadSettings(dir);
  assert.equal(settings.server.port, 3210);
  assert.equal(settings.companion.name, 'Vivi');
  assert.equal(settings.voice.provider, 'volcengine');
  assert.equal(statSync(join(dir, 'config.json')).mode & 0o777, 0o600);
});

test('rejects a malformed file instead of silently resetting it', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'config.json'), '{ not json');
  assert.throws(() => loadSettings(dir), /无法解析/);
});

test('partial update keeps fields it did not mention', () => {
  const dir = tempDir();
  updateSettings(dir, { voice: { volcengine: { apiKey: 'secret-key' } } });
  const next = updateSettings(dir, { companion: { name: '阿月' } });
  assert.equal(next.voice.volcengine.apiKey, 'secret-key');
  assert.equal(next.companion.name, '阿月');
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).voice.volcengine.apiKey, 'secret-key');
});

test('a nested provider patch keeps sibling fields', () => {
  const dir = tempDir();
  updateSettings(dir, { voice: { volcengine: { apiKey: 'k', voiceId: 'v1' } } });
  const next = updateSettings(dir, { voice: { volcengine: { voiceId: 'v2' } } });
  assert.equal(next.voice.volcengine.apiKey, 'k');
  assert.equal(next.voice.volcengine.voiceId, 'v2');
});

test('rejects invalid patches without touching the file', () => {
  const dir = tempDir();
  loadSettings(dir);
  const before = readFileSync(join(dir, 'config.json'), 'utf8');
  assert.throws(() => updateSettings(dir, { server: { port: 99999 } }));
  assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), before);
});

test('masks secrets to presence flags', () => {
  const dir = tempDir();
  const masked = maskSettings(updateSettings(dir, { voice: { volcengine: { apiKey: 'k' }, fish: { apiKey: 'f' } }, brain: { apiKey: '' } }));
  const json = JSON.stringify(masked);
  assert.equal(json.includes('"k"') || json.includes('"f"'), false);
  assert.equal(masked.voice.volcengine.hasApiKey, true);
  assert.equal(masked.voice.fish.hasApiKey, true);
  assert.equal(masked.brain.hasApiKey, false);
});

test('each voice provider keeps its own key when switching between them', () => {
  const dir = tempDir();
  updateSettings(dir, { voice: { volcengine: { apiKey: 'volc' } } });
  updateSettings(dir, { voice: { provider: 'fish', fish: { apiKey: 'fish', referenceId: 'r1' } } });
  const back = updateSettings(dir, { voice: { provider: 'volcengine' } });
  assert.equal(back.voice.volcengine.apiKey, 'volc');
  assert.equal(back.voice.fish.apiKey, 'fish');
  assert.equal(back.voice.fish.referenceId, 'r1');
});

test('migrates the flat pre-provider voice config without losing the key', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    voice: { provider: 'volcengine', apiKey: 'old-key', resourceId: 'seed-tts-2.0', voiceId: 'my_voice', speechRate: 10, timeoutMs: 30000 },
  }));
  const settings = loadSettings(dir);
  assert.equal(settings.voice.provider, 'volcengine');
  assert.equal(settings.voice.volcengine.apiKey, 'old-key');
  assert.equal(settings.voice.volcengine.voiceId, 'my_voice');
  assert.equal(settings.voice.speechRate, 10);
  // The migrated shape is written back so the old flat fields are gone from disk.
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).voice.volcengine.apiKey, 'old-key');
});

test('the browser patch schema applies no defaults, so a partial save resets nothing', () => {
  const dir = tempDir();
  updateSettings(dir, { voice: { provider: 'fish', volcengine: { apiKey: 'volc' } }, brain: { model: 'm1' } });
  const patch = settingsPatchSchema.parse({ voice: { fish: { apiKey: 'f' } } });
  assert.deepEqual(patch, { voice: { fish: { apiKey: 'f' } } });
  const next = updateSettings(dir, patch);
  assert.equal(next.voice.provider, 'fish');
  assert.equal(next.voice.volcengine.apiKey, 'volc');
  assert.equal(next.brain.model, 'm1');
});

test('the browser patch schema rejects unknown fields and server settings', () => {
  assert.throws(() => settingsPatchSchema.parse({ server: { port: 1 } }));
  assert.throws(() => settingsPatchSchema.parse({ voice: { fish: { model: 'gpt-4' } } }));
});
