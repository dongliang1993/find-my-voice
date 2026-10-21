import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const help = 'Usage: sh install.command [--scope user|workspace] [--workspace /path/to/workspace] [--client codex|manual] [--skip-deps]';
if (args.includes('--help')) { console.log(help); process.exit(0); }
const options = { scope: 'workspace', client: 'codex' };
let skipDeps = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--skip-deps') { skipDeps = true; continue; }
  if (!['--scope', '--workspace', '--client'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(help);
  options[args[i].slice(2)] = args[++i];
}
if (!['user', 'workspace'].includes(options.scope) || !['codex', 'manual'].includes(options.client)) throw new Error(help);
if (options.scope === 'user' && options.workspace) throw new Error('Choose --scope user OR --workspace, not both.');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) throw new Error('Node.js >= 22.13 is required.');
if (process.platform !== 'darwin') throw new Error('This installer supports macOS streaming playback. Other platforms require a separate player adapter.');
try { execFileSync('/usr/bin/xcrun', ['--find', 'swiftc'], { stdio: 'ignore' }); }
catch { throw new Error('Install the macOS compiler first: xcode-select --install. Then run this installer again.'); }
const run = (command, parameters) => execFileSync(command, parameters, { cwd: root, stdio: 'inherit' });
if (skipDeps) {
  if (!existsSync(resolve(root, 'node_modules'))) throw new Error('--skip-deps requires existing dependencies.');
} else run('npm', ['ci']);
run(process.execPath, ['scripts/init-env.mjs']);
run('npm', ['run', 'build']);
run(process.execPath, ['scripts/check-local.mjs']);
if (options.client === 'codex') {
  run(process.execPath, ['scripts/setup-codex.mjs', '--scope', options.scope, ...(options.workspace ? ['--workspace', options.workspace] : [])]);
} else {
  mkdirSync(resolve(root, 'data'), { recursive: true, mode: 0o700 });
  const path = resolve(root, 'data/connection.local.json');
  writeFileSync(path, JSON.stringify({ mcpServers: { finding_my_voice: {
    command: process.execPath, args: [resolve(root, 'dist/stdio.js')], cwd: root,
  } }, skills: ['finding-my-voice-setup', 'identity-evolution', 'voice-expression'].map(name => resolve(root, 'skills', name)) }, null, 2), { mode: 0o600 });
  console.log(`Local connection descriptor: ${path}. Have your client agent register the MCP and the bundled skills using its supported configuration.`);
}
console.log('Install complete. Privately configure your own Volcengine credentials, resource and speaker in .env. Existing .env and private data were preserved.');
console.log('Reload the client, then say: 初始化 Finding My Voice，带我整理共同经历并由你选择声音。');
