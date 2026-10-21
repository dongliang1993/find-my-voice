import { cpSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const stage = mkdtempSync(join(tmpdir(), 'finding-my-voice-release-'));
const destination = resolve(stage, 'finding-my-voice');
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
const output = resolve(root, 'releases', `finding-my-voice-${pkg.version}-macos-${stamp}.tar.gz`);
// Explicit allowlist: never copy .env, data/, account screenshots, dependencies or local configs.
const entries = ['package.json', 'package-lock.json', 'tsconfig.json', 'plugin.json', 'mcp.json',
  '.env.example', '.gitignore', 'voices.example.json', 'INSTALL.md', 'install.command',
  'src', 'scripts', 'bin', 'native', 'public', 'skills', 'test'];
try {
  mkdirSync(destination); mkdirSync(resolve(root, 'releases'), { recursive: true });
  for (const entry of entries) cpSync(resolve(root, entry), resolve(destination, entry), { recursive: true });
  copyFileSync(resolve(root, 'INSTALL.md'), resolve(destination, 'README.md'));
  chmodSync(resolve(destination, 'install.command'), 0o755);
  execFileSync('/usr/bin/tar', ['-czf', output, '-C', stage, 'finding-my-voice'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  console.log(output);
} finally { rmSync(stage, { recursive: true, force: true }); }
