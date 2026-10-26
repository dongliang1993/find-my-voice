import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/server/app.js';
import { createHttp } from '../src/server/http.js';
import { DEFAULT_IDENTITY } from '../src/server/profile/profile.js';

type Doc = { content: string; sha256: string | null };

/** An app on a throwaway data dir, with the settings page's two identity calls. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'fmv-identity-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ voice: { provider: 'fixture' } }));
  const app = new App(dir, () => {});
  const { http } = createHttp(app, dir);
  const headers = { host: '127.0.0.1:3210', 'content-type': 'application/json' };
  const read = () => http.request('/api/profile/identity', { headers });
  const write = (content: unknown, baseSha256: unknown) => http.request('/api/profile/identity', {
    method: 'PUT', headers, body: JSON.stringify({ content, baseSha256 }),
  });
  return { app, dir, read, write };
}

test('before the file exists, the default identity stands in', async () => {
  const { app, read } = setup();
  const doc = await (await read()).json() as Doc;
  assert.equal(doc.content, DEFAULT_IDENTITY);
  assert.equal(doc.sha256, null);
  await app.close();
});

test('a save lands in IDENTITY.md and the next one chains on its sha', async () => {
  const { app, dir, read, write } = setup();
  const first = await (await write('# 我是谁\n安静。\n', null)).json() as Doc;
  assert.ok(first.sha256);
  const second = await write('# 我是谁\n安静，爱笑。\n', first.sha256);
  assert.equal(second.status, 200);
  assert.equal(readFileSync(join(dir, 'IDENTITY.md'), 'utf8'), '# 我是谁\n安静，爱笑。\n');
  assert.equal(((await (await read()).json()) as Doc).content, '# 我是谁\n安静，爱笑。\n');
  await app.close();
});

test('a save against a stale sha is refused, not merged', async () => {
  const { app, dir, write } = setup();
  const first = await (await write('# 我是谁\n一。\n', null)).json() as Doc;
  writeFileSync(join(dir, 'IDENTITY.md'), '# 我是谁\n在编辑器里改过。\n');
  const response = await write('# 我是谁\n二。\n', first.sha256);
  assert.equal(response.status, 409);
  assert.equal(readFileSync(join(dir, 'IDENTITY.md'), 'utf8'), '# 我是谁\n在编辑器里改过。\n');
  await app.close();
});

test('a malformed body is a 400', async () => {
  const { app, write } = setup();
  assert.equal((await write(42, null)).status, 400);
  assert.equal((await write('ok', 7)).status, 400);
  await app.close();
});
