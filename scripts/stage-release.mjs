import { cpSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = resolve(root, 'releases/github-source');
const entries = ['package.json', 'package-lock.json', 'tsconfig.json', 'plugin.json', 'mcp.json',
  '.env.example', '.gitignore', 'voices.example.json', 'INSTALL.md', 'install.command',
  '.github', 'src', 'scripts', 'bin', 'native', 'public', 'skills', 'test'];
mkdirSync(destination, { recursive: true });
for (const entry of entries) {
  if (existsSync(resolve(root, entry))) cpSync(resolve(root, entry), resolve(destination, entry), { recursive: true });
}
copyFileSync(resolve(root, 'INSTALL.md'), resolve(destination, 'README.md'));
console.log(destination);
