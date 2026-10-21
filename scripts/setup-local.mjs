import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const envPath = resolve(root, '.env');
const argv = process.argv.slice(2);
const interactive = process.stdin.isTTY && !argv.includes('--json') && !argv.includes('--no-prompt');
const agentIndex = argv.indexOf('--agent');
const agent = agentIndex >= 0 ? argv[agentIndex + 1] : undefined;
if (agent && agent !== 'codex') throw new Error('The supported CLI handoff is --agent codex. Other clients can run the setup skill in their current conversation.');

export function updatePrivateEnv(content, changes) {
  let updated = content;
  for (const [key, value] of Object.entries(changes)) {
    if (!/^[A-Z][A-Z0-9_]+$/.test(key) || /[\r\n\0\s#'"`\\]/.test(value)) throw new Error('Invalid local configuration value.');
    const pattern = new RegExp(`^${key}=.*$`, 'gm');
    updated = pattern.test(updated) ? updated.replace(pattern, () => `${key}=${value}`) : `${updated.trimEnd()}\n${key}=${value}\n`;
  }
  return updated;
}

function secretQuestion(prompt) {
  return new Promise((resolvePromise, reject) => {
    const input = process.stdin; const raw = input.isRaw; let value = '';
    process.stdout.write(prompt); emitKeypressEvents(input); input.setRawMode(true); input.resume();
    const finish = error => {
      input.removeListener('keypress', handler); input.setRawMode(Boolean(raw)); input.pause(); process.stdout.write('\n');
      error ? reject(error) : resolvePromise(value);
    };
    const handler = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('Configuration cancelled.'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace' || key.name === 'delete') { value = value.slice(0, -1); return; }
      if (!key.ctrl && !key.meta && text && /^[\x21-\x7e]+$/.test(text)) value += text;
    };
    input.on('keypress', handler);
  });
}

async function main() {
  const original = readFileSync(envPath, 'utf8');
  const configured = parseEnv(original);
  if (interactive) {
    console.log('Finding My Voice setup · credentials stay in your local .env. This step does not generate paid audio.');
    const changes = {};
    if (!configured.VOLC_API_KEY && !(configured.VOLC_APP_ID && configured.VOLC_ACCESS_KEY)) {
      const key = await secretQuestion('火山 API Key（输入不回显；回车暂时跳过）：');
      if (key) changes.VOLC_API_KEY = key;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      for (const [key, label, fallback] of [
        ['VOLC_RESOURCE_ID', '账户已开通的资源 ID', 'seed-tts-2.0'],
        ['VOLC_DEFAULT_VOICE', '账户可用的 speaker ID（不是声音显示名称）', ''],
      ]) {
        const value = (await rl.question(`${label}${configured[key] ? '（已配置，回车保留）' : fallback ? ` [${fallback}]` : '（可暂时跳过）'}：`)).trim();
        if (value) changes[key] = value;
        else if (!configured[key] && fallback) changes[key] = fallback;
      }
      const mode = (await rl.question('开启 Agent 自主语音判断，并在本机直接播放？[y/N，回车保留现状]：')).trim().toLowerCase();
      if (['y', 'yes'].includes(mode)) { changes.VOICE_REPLY_MODE = 'adaptive'; changes.LOCAL_AUDIO_PLAYBACK = 'stream'; }
      else if (['n', 'no'].includes(mode)) { changes.VOICE_REPLY_MODE = 'explicit'; changes.LOCAL_AUDIO_PLAYBACK = 'none'; }
    } finally { rl.close(); }
    if (Object.keys(changes).length) {
      writeFileSync(`${envPath}.tmp`, updatePrivateEnv(original, changes), { mode: 0o600 });
      renameSync(`${envPath}.tmp`, envPath);
      console.log('本机配置已保存；请重载客户端 MCP 连接后使用新配置。');
    }
  }
  const { loadConfig, VoiceService } = await import('../dist/cli-api.js');
  const config = loadConfig(); const service = new VoiceService(config);
  // This CLI does not host a review server. The host agent obtains live review URLs from its MCP connection.
  service.assets.baseUrl = '';
  let state;
  try {
    state = service.setup(true).data;
    delete state.management_url;
    state.steps = state.steps.map(({ review_url, ...step }) => step);
  } finally { service.close(); }
  if (argv.includes('--json')) console.log(JSON.stringify({ ...state, config_file: envPath, paid_audio_generated: false }, null, 2));
  else {
    console.log(`\n当前步骤：${state.steps.find(s => s.id === state.next_step)?.label || '已就绪'}\n${state.next_action}`);
    if (!state.provider_configured) console.log(`真实试听前还需在本机配置火山凭证和音色：${envPath}`);
    console.log(`\n接下来在你的 Agent 对话中继续：\n${state.resume_prompt}\n`);
    console.log('记忆整理和选声使用宿主 Agent 的模型与可用上下文；CLI 本身不会读取所有历史对话，也不会代你确认保存。');
  }
  if (agent) {
    if (!process.stdin.isTTY) throw new Error('Run --agent codex from an interactive terminal, or continue setup in your current agent conversation.');
    const result = spawnSync('codex', [state.resume_prompt], { cwd: process.env.FMV_SETUP_WORKSPACE || process.cwd(), stdio: 'inherit' });
    if (result.error?.code === 'ENOENT') throw new Error('Codex CLI was not found. Open your client and send the setup prompt shown above.');
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Local setup failed.'); process.exitCode = 1; });
}
