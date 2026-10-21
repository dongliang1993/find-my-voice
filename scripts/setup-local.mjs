import { readFileSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
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

export function setupOptions(args) {
  const importIndex = args.indexOf('--import-config');
  const importConfig = importIndex >= 0 ? args[importIndex + 1] : undefined;
  if (importIndex >= 0 && (!importConfig || importConfig.startsWith('--'))) throw new Error('--import-config requires a local .env file path.');
  const connect = args.includes('--connect') || Boolean(importConfig);
  const advanced = args.includes('--advanced');
  if (advanced && !connect) throw new Error('Use --connect --advanced to edit provider-specific settings.');
  if (args.includes('--json') && (connect || args.includes('--agent'))) throw new Error('--json is read-only; do not combine it with connection changes or Agent launch.');
  return { connect, advanced, importConfig };
}

export function providerSettings(content) {
  const parsed = parseEnv(content);
  const keys = ['VOLC_API_KEY', 'VOLC_APP_ID', 'VOLC_ACCESS_KEY', 'VOLC_RESOURCE_ID', 'VOLC_DEFAULT_VOICE', 'VOLC_DEFAULT_VOICE_NAME'];
  // Explicit reuse copies only provider settings, never owner, tokens, data paths or memories.
  const settings = Object.fromEntries(keys.filter(key => parsed[key]).map(key => [key, parsed[key]]));
  if (settings.VOLC_API_KEY) { settings.VOLC_APP_ID = ''; settings.VOLC_ACCESS_KEY = ''; }
  else if (settings.VOLC_APP_ID && settings.VOLC_ACCESS_KEY) settings.VOLC_API_KEY = '';
  return settings;
}

export function updatePrivateEnv(content, changes) {
  let updated = content;
  for (const [key, value] of Object.entries(changes)) {
    const displayName = key === 'VOLC_DEFAULT_VOICE_NAME';
    if (!/^[A-Z][A-Z0-9_]+$/.test(key) || /[\r\n\0#'"`\\]/.test(value) || /\s/.test(displayName ? value.replaceAll(' ', '') : value)) throw new Error('Invalid local configuration value.');
    const encoded = displayName && value.includes(' ') ? JSON.stringify(value) : value;
    const pattern = new RegExp(`^${key}=.*$`, 'gm');
    updated = pattern.test(updated) ? updated.replace(pattern, () => `${key}=${encoded}`) : `${updated.trimEnd()}\n${key}=${encoded}\n`;
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
  const options = setupOptions(argv);
  const original = readFileSync(envPath, 'utf8');
  const changes = options.importConfig ? providerSettings(readFileSync(resolve(options.importConfig), 'utf8')) : {};
  if (options.importConfig && !changes.VOLC_API_KEY && !(changes.VOLC_APP_ID && changes.VOLC_ACCESS_KEY)) {
    throw new Error('The selected file has no usable provider credentials. No configuration was changed.');
  }
  const configured = { ...parseEnv(original), ...changes };
  if (options.connect) {
    console.log('连接语音服务 · 凭证只保存在本机，不生成收费音频。资源参数由候选目录提供，不要求手填音色 ID。');
    if (!configured.VOLC_API_KEY && !(configured.VOLC_APP_ID && configured.VOLC_ACCESS_KEY)) {
      if (!interactive) throw new Error('Use setup --connect in an interactive terminal, or explicitly reuse a local file with --import-config FILE. Never paste keys into chat.');
      const key = await secretQuestion('火山 API Key（输入不回显；回车跳过，保留已有记忆和画像）：');
      if (key) { changes.VOLC_API_KEY = key; configured.VOLC_API_KEY = key; }
    }
    if (options.advanced) {
      if (!interactive) throw new Error('--advanced requires an interactive terminal.');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        for (const [key, label] of [
          ['VOLC_RESOURCE_ID', '资源 ID（仅账户特殊配置需要）'],
          ['VOLC_DEFAULT_VOICE', '额外候选 speaker ID（不是正式角色选声）'],
        ]) {
          const value = (await rl.question(`${label}（回车保留）：`)).trim();
          if (value) changes[key] = value;
        }
      } finally { rl.close(); }
    }
  }
  if (Object.keys(changes).length) {
    writeFileSync(`${envPath}.tmp`, updatePrivateEnv(original, changes), { mode: 0o600 });
    renameSync(`${envPath}.tmp`, envPath);
    console.log('本机语音配置已保存；请重载客户端 MCP 连接。记忆、画像及语音模式未修改。');
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
    if (!state.provider_configured) console.log('现在无需配置语音。先由当前 Agent 整理记忆和画像；试听前再运行 setup --connect。');
    console.log(`\n请在当前已有交流的 Agent 对话中说“初始化 Finding My Voice”，不要另开空白对话。\n完整交接口令：\n${state.resume_prompt}\n`);
    console.log('记忆整理和选声使用宿主 Agent 的模型与可用上下文；CLI 本身不会读取所有历史对话，也不会代你确认保存。');
  }
  if (agent) {
    if (!process.stdin.isTTY) throw new Error('Run --agent codex from an interactive terminal, or continue setup in your current agent conversation.');
    console.log('注意：--agent codex 将启动新的 CLI 对话，不会继承当前聊天。需要当前交流内容时，请取消并回到原对话初始化。');
    const result = spawnSync('codex', [state.resume_prompt], { cwd: process.env.FMV_SETUP_WORKSPACE || process.cwd(), stdio: 'inherit' });
    if (result.error?.code === 'ENOENT') throw new Error('Codex CLI was not found. Open your client and send the setup prompt shown above.');
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Local setup failed.'); process.exitCode = 1; });
}
