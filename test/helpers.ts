import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Settings } from '../src/config.js';
import { VoiceService } from '../src/service.js';
import type { TtsProvider } from '../src/provider.js';

export const testEnv = { PATH: process.env.PATH || '' };
export const testTokens = {
  mcp: 'test-mcp-token-00000000000000000000000', signingKey: 'test-media-key-00000000000000000000000',
};
/** Old .env-style names, so tests can keep passing a flat override map. */
const envNames: Record<string, [keyof Settings, string]> = {
  TTS_PROVIDER: ['provider', 'type'], VOLC_API_KEY: ['provider', 'apiKey'], VOLC_APP_ID: ['provider', 'appId'],
  VOLC_ACCESS_KEY: ['provider', 'accessKey'], VOLC_RESOURCE_ID: ['provider', 'resourceId'],
  VOLC_DEFAULT_VOICE: ['provider', 'defaultVoice'], VOLC_API_MODE: ['provider', 'apiMode'],
  VOICE_REPLY_MODE: ['voice', 'replyMode'], LOCAL_AUDIO_PLAYBACK: ['voice', 'localPlayback'],
  OWNER_ID: ['owner', 'id'], PORT: ['server', 'port'],
};

/** Writes a settings.json into a throwaway dir so each test is isolated. */
export function setup(provider?: TtsProvider, patch: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'finding-my-voice-test-'));
  const settings: Record<string, Record<string, unknown>> = { tokens: testTokens };
  for (const [key, value] of Object.entries(patch)) {
    const mapped = envNames[key];
    if (mapped) (settings[mapped[0]] ??= {})[mapped[1]] = value;
    else settings[key] = value as Record<string, unknown>;
  }
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
  process.env.PLUGIN_DATA = dir;
  const config = loadConfig();
  const service = new VoiceService(config, provider); service.assets.baseUrl = 'http://127.0.0.1:3210';
  return { service, config, dir, cleanup: () => { service.close(); rmSync(dir, { recursive: true, force: true }); } };
}
export const entries = [
  { kind: 'discussion', content: '讨论了工具与角色的关系。', source: '用户提供的材料1', participant: 'both', is_inference: false },
  { kind: 'disagreement', content: '对固定音色和生成式声音有不同的初始判断。', source: '测试材料2', participant: 'both', is_inference: true },
] as const;
export const persona = {
  display_name: '测试角色', expression_principles: ['清楚说明依据。'],
  traits: [{ name: '直接', description: '先说结论，再说明理由。', evidence: ['测试材料1'] }],
  disagreement_style: '保留分歧并说明依据。', relationship_position: '一起进行声音实验的协作者。', uncertainties: ['声音质感尚待试听。'],
};
export const memoryMarkdown = '# 记忆\n\n## 回顾范围\n仅测试材料，不是真实历史。\n\n## 当前有效记忆\nM-001：交流偏好，保留分歧。来源：测试会话 1。\n\n## 记忆时间线\n### 日期不详\nM-001：共同讨论工具和表达方式。来源：测试会话 1。\n\n## 冲突与待核实\n本次测试未发现冲突。\n\n## 同步记录\n首次同步测试会话 1。\n';
export const identityMarkdown = '# Agent 画像\n\n## 个人形象\n本次初始设计：一个带柔和光晕的抽象圆点，无图片资产。来源：测试材料。\n\n## 性格与关系\n可讨论的对话者，保留独立判断。来源：MEMORY.md M-001。\n\n## 声音\n表达设计：自然轻快，与圆点的轻盈感匹配；音色待试听确认。正式绑定以运行时为准。\n\n## 演化记录\n测试初次设计，声音质感尚未试听。\n';
export function writeProfiles(service: VoiceService) {
  service.profileWrite({ document: 'memory', content: memoryMarkdown, base_sha256: null });
  service.profileWrite({ document: 'identity', content: identityMarkdown, base_sha256: null });
}
