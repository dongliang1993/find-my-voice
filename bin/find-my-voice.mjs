#!/usr/bin/env node
// `npx find-my-voice` — starts the local server and opens the chat in the browser.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`find-my-voice 需要 Node.js 22.13 或更高版本（当前 ${process.versions.node}）。`);
  process.exit(1);
}
const entry = fileURLToPath(new URL('../dist/server/index.js', import.meta.url));
if (!existsSync(entry)) {
  console.error('找不到构建产物，请先运行 npm run build。');
  process.exit(1);
}
await import(entry);
