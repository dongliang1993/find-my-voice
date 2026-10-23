import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/server/app.js';
import { createHttp } from '../src/server/http.js';

/** An app on a throwaway data dir; no ElevenLabs key, so nothing ever calls out. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'fmv-hear-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ voice: { provider: 'fixture' } }));
  const app = new App(dir, () => {});
  const { http } = createHttp(app, dir);
  const post = (body: BodyInit, type: string) => http.request('/api/onboarding/hear-alias', {
    method: 'POST', body, headers: { host: '127.0.0.1:3210', 'content-type': type },
  });
  return { app, post };
}

test('status reports she cannot listen without an ElevenLabs key', async () => {
  const { app } = setup();
  assert.equal(app.status().listen.ready, false);
  await app.close();
});

test('only audio is accepted', async () => {
  const { app, post } = setup();
  const response = await post('hello', 'text/plain');
  assert.equal(response.status, 415);
  await app.close();
});

test('an empty clip is refused before any transcription', async () => {
  const { app, post } = setup();
  const response = await post(new Uint8Array(0), 'audio/webm');
  assert.equal(response.status, 400);
  await app.close();
});

test('an oversized clip is refused', async () => {
  const { app, post } = setup();
  const response = await post(new Uint8Array(3 * 1024 * 1024), 'audio/webm');
  assert.equal(response.status, 413);
  await app.close();
});

test('without a key the answer is a clear setup error, not a crash', async () => {
  const { app, post } = setup();
  const response = await post(new Uint8Array([1, 2, 3, 4]), 'audio/webm');
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { code: string }).code, 'SETUP_REQUIRED');
  await app.close();
});

test('once onboarding is over, nothing is transcribed', async () => {
  const { app, post } = setup();
  app.saveOnboarding(7, {}, true);
  const response = await post(new Uint8Array([1, 2, 3, 4]), 'audio/webm');
  assert.equal(response.status, 409);
  await app.close();
});
