import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';

const root = fileURLToPath(new URL('../', import.meta.url));
const envPath = resolve(root, '.env');
const argv = process.argv.slice(2);
const interactive = process.stdin.isTTY && !argv.includes('--json') && !argv.includes('--no-prompt');

export function setupOptions(args) {
  const value = flag => {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${flag} requires a value.`);
    return args[index + 1];
  };
  const agent = value('--agent');
  if (agent && !['codex', 'request'].includes(agent)) throw new Error('Use --agent codex for headless extraction, or --agent request to prepare a host request.');
  const histories = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--history') {
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--history requires an authorized local file path.');
    histories.push(resolve(args[++i]));
  }
  if (!agent && (histories.length || args.includes('--refresh-profile'))) throw new Error('--history and --refresh-profile require --agent codex or --agent request.');
  const importIndex = args.indexOf('--import-config');
  const importConfig = importIndex >= 0 ? args[importIndex + 1] : undefined;
  if (importIndex >= 0 && (!importConfig || importConfig.startsWith('--'))) throw new Error('--import-config requires a local .env file path.');
  const connect = args.includes('--connect') || Boolean(importConfig);
  const advanced = args.includes('--advanced');
  if (advanced && !connect) throw new Error('Use --connect --advanced to edit provider-specific settings.');
  if (args.includes('--json') && (connect || args.includes('--agent'))) throw new Error('--json is read-only; do not combine it with connection changes or Agent launch.');
  return { connect, advanced, importConfig, agent, histories, refresh: args.includes('--refresh-profile') };
}

// --import-config still reads a .env, so its key names are mapped onto the
// settings.json provider group on the way in.
const envToSetting = {
  TTS_PROVIDER: 'type', VOLC_API_KEY: 'apiKey', VOLC_APP_ID: 'appId', VOLC_ACCESS_KEY: 'accessKey',
  VOLC_RESOURCE_ID: 'resourceId', VOLC_DEFAULT_VOICE: 'defaultVoice', VOLC_DEFAULT_VOICE_NAME: 'defaultVoiceName',
};

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
  const { ensureSettings, readSettings, mergeSettings, loadConfig, VoiceService, extractSetupProfile } = await import('../dist/cli-api.js');
  ensureSettings();
  const changes = options.importConfig ? providerSettings(readFileSync(resolve(options.importConfig), 'utf8')) : {};
  if (options.importConfig && !changes.VOLC_API_KEY && !(changes.VOLC_APP_ID && changes.VOLC_ACCESS_KEY)) {
    throw new Error('The selected file has no usable provider credentials. No configuration was changed.');
  }
  // Only provider fields are ever written here; owner, tokens and limits stay put.
  const patch = {};
  if (options.connect) {
    console.log('连接语音服务 · 凭证只保存在本机 settings.json，不生成收费音频。资源参数由候选目录提供，不要求手填音色 ID。');
    const current = readSettings().provider ?? {};
    // An explicit import already supplied the credential; only prompt when it is
    // absent from both the existing file and the import.
    const supplied = changes.VOLC_API_KEY || (changes.VOLC_APP_ID && changes.VOLC_ACCESS_KEY);
    if (!supplied && !current.apiKey && !(current.appId && current.accessKey)) {
      if (!interactive) throw new Error('Use setup --connect in an interactive terminal, or explicitly reuse a local file with --import-config FILE. Never paste keys into chat.');
      const key = await secretQuestion('火山 API Key（输入不回显；回车跳过，保留已有记忆和画像）：');
      if (key) changes.VOLC_API_KEY = key;
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
    if (options.importConfig || Object.keys(changes).length) changes.TTS_PROVIDER = 'volcengine';
  }
  if (Object.keys(changes).length) {
    // .env key names map onto the provider group of settings.json.
    patch.provider = Object.fromEntries(Object.entries(changes)
      .map(([key, value]) => [envToSetting[key], value]).filter(([key]) => key));
    mergeSettings(patch);
    console.log('本机语音配置已保存到 settings.json；重连 MCP 后生效。记忆、画像及语音模式未修改。');
  }
  const config = loadConfig(); const service = new VoiceService(config);
  // This CLI does not host a review server. The host agent obtains live review URLs from its MCP connection.
  service.assets.baseUrl = '';
  let state;
  try {
    const profile = service.context().profile_documents;
    if (options.agent && (options.agent === 'request' || !profile.layout.ready || options.refresh || options.histories.length)) {
      console.log('setup · 由 AI 生成/同步 MEMORY.md 和分块 IDENTITY.md；无界面调用不会自动继承云端历史。不生成付费音频。');
      const extraction = await extractSetupProfile(service, { sources: options.histories, prepareOnly: options.agent === 'request', onProgress: console.log });
      if (extraction.status === 'request_prepared') console.log(`请在有历史权限的宿主提交此请求，并附上其引用的获授权材料：${extraction.request_path}`);
      else console.log(`两份资料已保存：\n${extraction.memory}\n${extraction.identity}\n历史覆盖缺口：${extraction.coverage_limits.join('；') || '模型未报告额外缺口；仍不代表自动获得全部云端聊天。'}`);
    } else if (options.agent) console.log('资料分块已就绪，本次不重写；同步新材料可加 --history FILE 或 --refresh-profile。');
    state = service.setup(true).data;
    delete state.management_url;
    state.steps = state.steps.map(({ review_url, ...step }) => step);
  } finally { service.close(); }
  if (argv.includes('--json')) console.log(JSON.stringify({ ...state, config_file: envPath, paid_audio_generated: false }, null, 2));
  else {
    console.log(`\n当前步骤：${state.steps.find(s => s.id === state.next_step)?.label || '已就绪'}\n${state.next_action}`);
    if (!state.provider_configured) console.log('现在无需配置语音。先由当前 Agent 整理记忆和画像；试听前再运行 setup --connect。');
    console.log(`\n记忆文档：${state.profile_documents.memory.path}\n表达画像：${state.profile_documents.identity.path}`);
    if (!state.profile_documents.layout.ready) console.log(`\n可在当前 Agent 对话中说“初始化 Finding My Voice”。\n完整交接口令：\n${state.resume_prompt}\n`);
    else console.log('两份资料分块已就绪；按当前步骤继续，不必重复初始化。');
    console.log('也可用 setup --agent codex --history FILE 无界面提取；--history 可重复传入历史、原生记忆或已有形象描述。没有 CLI 时用 --agent request 准备同一请求。正式声音仍由你确认。');
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Local setup failed.'); process.exitCode = 1; });
}
