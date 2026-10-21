#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const argv = process.argv.slice(2);
const command = argv.shift() || 'help';
const flags = new Map();
for (let i = 0; i < argv.length; i++) {
  const name = argv[i];
  if (['--json', '--no-prompt', '--help', '--connect', '--advanced'].includes(name)) { flags.set(name, true); continue; }
  if (!['--install-dir', '--workspace', '--scope', '--client', '--agent', '--import-config'].includes(name) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
    console.error(`Unknown or incomplete option: ${name}`); process.exit(1);
  }
  flags.set(name, argv[++i]);
}
const help = `Find My Voice · local MCP + skills

  npx find-my-voice install                 Install in ~/.find-my-voice and register user-level Codex tools
  npx find-my-voice install --workspace DIR Register only in a selected workspace
  npx find-my-voice install --client manual Prepare a descriptor for another local MCP client
  npx find-my-voice setup                   Continue in your CURRENT Agent conversation; no credential questionnaire
  npx find-my-voice setup --connect         Connect TTS privately when ready to audition (API Key only)
  npx find-my-voice setup --import-config FILE  Explicitly reuse provider settings from your own local .env
  npx find-my-voice setup --connect --advanced  Optional account-specific resource/speaker settings
  npx find-my-voice setup --agent codex     Opt in to a NEW Codex CLI conversation (no existing chat context)
  npx find-my-voice setup --json            Read progress without prompts, credential changes or paid audio
  npx find-my-voice doctor                  Check the installed MCP without paid audio

Options: --install-dir DIR, --scope user|workspace. macOS, Node.js >= 22.13, and Command Line Tools required.
`;
if (command === 'help' || flags.has('--help') || command === '--help') { console.log(help); process.exit(0); }
const installationRoot = resolve(String(flags.get('--install-dir') || process.env.FIND_MY_VOICE_HOME || resolve(homedir(), '.find-my-voice')));
const appRoot = resolve(installationRoot, 'app');
const markerPath = resolve(installationRoot, 'installation.json');
const run = (file, args, cwd = appRoot) => execFileSync(file, args, { cwd, stdio: 'inherit' });

try {
  if (command !== 'setup' && ['--connect', '--advanced', '--import-config', '--agent'].some(flag => flags.has(flag))) throw new Error('Connection changes and Agent launch are supported only by setup.');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error('Node.js >= 22.13 is required.');
  if (command === 'install') {
    if (process.platform !== 'darwin') throw new Error('The current local player installer supports macOS only.');
    const scope = String(flags.get('--scope') || (flags.has('--workspace') ? 'workspace' : 'user'));
    const client = String(flags.get('--client') || 'codex');
    if (!['user', 'workspace'].includes(scope) || !['codex', 'manual'].includes(client) || (scope === 'user' && flags.has('--workspace'))) throw new Error('Choose user scope OR --workspace, and a supported client.');
    const workspace = scope === 'workspace' ? resolve(String(flags.get('--workspace') || process.cwd())) : undefined;
    if ([parse(installationRoot).root, homedir(), packageRoot, dirname(packageRoot)].includes(installationRoot)) throw new Error('Use a dedicated installation directory.');
    if (existsSync(installationRoot) && readdirSync(installationRoot).length && !existsSync(markerPath)) throw new Error('Installation directory contains unrelated files. Select an empty directory.');
    execFileSync('/usr/bin/xcrun', ['--find', 'swiftc'], { stdio: 'ignore' });
    const pkg = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
    if (!existsSync(resolve(packageRoot, 'dist/stdio.js'))) throw new Error('This package has no built MCP entrypoint. Build or use a release package.');
    mkdirSync(appRoot, { recursive: true, mode: 0o700 });
    // Persistent runtime, never .env/data or a link back into npx's transient cache.
    const entries = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', '.env.example', 'voices.example.json', 'plugin.json', 'mcp.json', 'bin', 'scripts', 'public', 'skills', 'native'];
    for (const entry of entries) {
      if (existsSync(resolve(packageRoot, entry))) cpSync(resolve(packageRoot, entry), resolve(appRoot, entry), { recursive: true });
    }
    mkdirSync(resolve(appRoot, 'dist'), { recursive: true });
    for (const entry of ['stdio.js', 'server.js', 'cli-api.js']) cpSync(resolve(packageRoot, 'dist', entry), resolve(appRoot, 'dist', entry));
    // The marker also lets a user retry a partially completed installation safely.
    writeFileSync(markerPath, JSON.stringify({ version: pkg.version, app_root: appRoot, scope, client,
      workspace,
      state: 'installing' }, null, 2), { mode: 0o600 });
    run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
    run(process.execPath, ['scripts/init-env.mjs']);
    run(process.execPath, ['scripts/build-player.mjs']);
    run(process.execPath, ['scripts/check-local.mjs']);
    if (client === 'codex') run(process.execPath, ['scripts/setup-codex.mjs', '--scope', scope,
      ...(workspace ? ['--workspace', workspace] : [])]);
    else {
      mkdirSync(resolve(appRoot, 'data'), { recursive: true, mode: 0o700 });
      writeFileSync(resolve(appRoot, 'data/connection.local.json'), JSON.stringify({ mcpServers: { finding_my_voice: {
        command: process.execPath, args: [resolve(appRoot, 'dist/stdio.js')], cwd: appRoot,
      } }, skills: ['finding-my-voice-setup', 'identity-evolution', 'voice-expression'].map(name => resolve(appRoot, 'skills', name)) }, null, 2), { mode: 0o600 });
    }
    writeFileSync(markerPath, JSON.stringify({ version: pkg.version, app_root: appRoot, scope, client,
      workspace,
      state: 'installed' }, null, 2), { mode: 0o600 });
    console.log(`Installed locally: ${appRoot}\nNext: npx find-my-voice setup\nReload your client to discover the MCP and skills.`);
  } else if (['setup', 'doctor', 'status'].includes(command)) {
    if (!existsSync(markerPath) || !existsSync(resolve(appRoot, 'dist/stdio.js'))) throw new Error('Run npx find-my-voice install first.');
    const installation = JSON.parse(readFileSync(markerPath, 'utf8'));
    if (installation.state !== 'installed') throw new Error('Installation is incomplete. Re-run npx find-my-voice install before setup.');
    if (command === 'doctor') run(process.execPath, ['scripts/check-local.mjs']);
    else {
      const args = ['scripts/setup-local.mjs', ...(flags.has('--json') ? ['--json'] : []), ...(flags.has('--no-prompt') ? ['--no-prompt'] : []),
        ...(flags.has('--connect') ? ['--connect'] : []), ...(flags.has('--advanced') ? ['--advanced'] : []),
        ...(flags.has('--import-config') ? ['--import-config', resolve(String(flags.get('--import-config')))] : []),
        ...(flags.has('--agent') ? ['--agent', String(flags.get('--agent'))] : [])];
      const result = spawnSync(process.execPath, args, { cwd: appRoot, stdio: 'inherit',
        env: { ...process.env, FMV_SETUP_WORKSPACE: installation.workspace || process.cwd() } });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    }
  } else throw new Error(help);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Find My Voice command failed.'); process.exitCode = 1;
}
