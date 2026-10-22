import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync, symlinkSync, lstatSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('Usage: npm run setup:codex -- [--scope workspace|user] [--workspace /path/to/workspace]'); process.exit(0); }
const options = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--claim-skills') continue;
  if (!['--scope', '--workspace', '--server-name'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid option. Use --help.');
  if (args[i] === '--server-name') options.serverName = args[++i];
  else options[args[i].slice(2)] = args[++i];
}
const scope = options.scope || 'workspace';
// --server-name lets a dev checkout coexist with the installed copy in the same client.
// `npm run setup:codex -- --server-name find_my_voice_dev --scope user` registers a second entry.
const serverName = options.serverName || 'finding_my_voice';
if (!['workspace', 'user'].includes(scope) || (scope === 'user' && options.workspace)) throw new Error('Choose user scope OR an explicit workspace, not both.');
const workspace = scope === 'user' ? homedir() : resolve(options.workspace || resolve(root, '..'));
if (!existsSync(resolve(root, 'dist/stdio.js'))) throw new Error('Run npm run build first.');
const configDir = resolve(workspace, '.codex'), path = resolve(configDir, 'config.toml');
let existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
const original = existing;
const begin = `# BEGIN finding-my-voice${serverName === 'finding_my_voice' ? '' : `:${serverName}`}`;
const end = `# END finding-my-voice${serverName === 'finding_my_voice' ? '' : `:${serverName}`}`;
const block = `${begin}\n[mcp_servers.${serverName}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(resolve(root, 'dist/stdio.js'))}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 360\n${end}\n`;
const blockPattern = new RegExp(`${begin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`);
if (existing.includes(begin)) existing = existing.replace(blockPattern, '');
else if (existing.includes(`[mcp_servers.${serverName}]`)) throw new Error(`An existing ${serverName} entry is not managed by this installer; review it before replacing.`);
const skillDir = resolve(workspace, '.agents/skills');
const skills = ['finding-my-voice-setup', 'identity-evolution', 'voice-expression'];
// Check every existing entry before changing either skills or the MCP config.
const claimSkills = args.includes('--claim-skills');
for (const skill of skills) {
  const target = resolve(root, 'skills', skill), link = resolve(skillDir, skill);
  if (!existsSync(resolve(target, 'SKILL.md'))) throw new Error(`Missing bundled skill ${skill}.`);
  if (existsSync(link) || (() => { try { return lstatSync(link).isSymbolicLink(); } catch { return false; } })()) {
    // --claim-skills lets a dev checkout take the shared links over from an installed copy.
    if (realpathSync(link) !== realpathSync(target) && !claimSkills) throw new Error(`Existing skill ${skill} belongs to another source; left unchanged. Re-run with --claim-skills to point it here.`);
  }
}
mkdirSync(configDir, { recursive: true }); mkdirSync(skillDir, { recursive: true });
const updated = `${existing.trimEnd()}\n\n${block}`.trimStart();
if (updated !== original) {
  if (existsSync(path)) copyFileSync(path, `${path}.finding-my-voice-${Date.now()}.bak`);
  const temporary = `${path}.finding-my-voice.tmp`;
  writeFileSync(temporary, updated, { mode: 0o600 }); renameSync(temporary, path);
}
for (const skill of skills) {
  const link = resolve(skillDir, skill);
  if (claimSkills && existsSync(link) && realpathSync(link) !== realpathSync(resolve(root, 'skills', skill))) unlinkSync(link);
  if (!existsSync(link)) symlinkSync(resolve(root, 'skills', skill), link, 'dir');
}
console.log(`Registered ${serverName} and three skills (${scope} scope) in ${workspace}. Reload the client, then say: 初始化 Finding My Voice。`);
