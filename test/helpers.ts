import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, projectRoot } from '../src/config.js';
import { VoiceService } from '../src/service.js';
import type { TtsProvider } from '../src/provider.js';

export const testEnv = {
  ADMIN_TOKEN: 'test-admin-token-000000000000000000000',
  MCP_TOKEN: 'test-mcp-token-00000000000000000000000',
  MEDIA_SIGNING_KEY: 'test-media-key-00000000000000000000000',
  OWNER_ID: 'test-owner', TTS_PROVIDER: 'fixture', PORT: '0',
  VOICE_REPLY_MODE: 'explicit', LOCAL_AUDIO_PLAYBACK: 'none',
};
export function setup(provider?: TtsProvider, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'finding-my-voice-test-'));
  const config = parseConfig({ ...testEnv, DATA_DIR: dir, ...env }, projectRoot);
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
