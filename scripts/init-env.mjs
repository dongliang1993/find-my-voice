import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(`${root}.env`)) {
  console.log('.env already exists; left unchanged.');
} else {
  let env = readFileSync(`${root}.env.example`, 'utf8');
  for (const key of ['MCP_TOKEN', 'MEDIA_SIGNING_KEY']) {
    env = env.replace(`${key}=\n`, `${key}=${randomBytes(32).toString('hex')}\n`);
  }
  writeFileSync(`${root}.env`, env, { mode: 0o600, flag: 'wx' });
  console.log('Created private .env. Fill in Volcengine credentials, resource ID and bootstrap voice.');
}
