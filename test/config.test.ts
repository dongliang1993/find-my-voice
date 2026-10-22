import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, maskSettings, updateSettings } from '../src/server/config.js';

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
  updateSettings(dir, { voice: { apiKey: 'secret-key' } });
  const next = updateSettings(dir, { companion: { name: '阿月' } });
  assert.equal(next.voice.apiKey, 'secret-key');
  assert.equal(next.companion.name, '阿月');
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).voice.apiKey, 'secret-key');
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
  const masked = maskSettings(updateSettings(dir, { voice: { apiKey: 'k' }, brain: { apiKey: '' } }));
  assert.equal(JSON.stringify(masked).includes('"k"'), false);
  assert.equal(masked.voice.hasApiKey, true);
  assert.equal(masked.brain.hasApiKey, false);
});
