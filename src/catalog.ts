import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Config } from './config.js';
import { DomainError } from './errors.js';

const voiceSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(160), name: z.string().min(1).max(160),
  description: z.string().max(1000), languages: z.array(z.enum(['zh', 'en'])).min(1),
  enabled: z.boolean(), resource_id: z.string().min(1).optional(),
}).strict();
export type Voice = z.infer<typeof voiceSchema> & { provider: 'volcengine' | 'fixture'; availability: 'configured' | 'unconfigured'; source: string };

export function listVoices(config: Config): Voice[] {
  if (config.provider === 'fixture') return [{
    id: 'fixture-tone', name: '测试提示音', description: '用于验证音频链路的合成提示音，不是火山引擎语音。',
    languages: ['zh', 'en'], enabled: true, provider: 'fixture', availability: 'configured', source: 'test fixture',
  }];
  const customPath = resolve(config.dataDir, 'voices.json');
  const path = existsSync(customPath) ? customPath : resolve(config.root, 'voices.example.json');
  const parsed = z.array(voiceSchema).safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new DomainError('INVALID_CATALOG', '音色目录格式无效，请检查 data/voices.json。');
  const voices = parsed.data;
  if (config.bootstrapVoice) {
    const existing = voices.find(v => v.id === config.bootstrapVoice);
    if (existing) { existing.enabled = true; existing.resource_id = config.volc.resourceId || existing.resource_id; }
    else voices.push({ id: config.bootstrapVoice, name: config.bootstrapVoiceName || config.bootstrapVoice,
      description: '用户在本地配置的测试音色，尚未确认作为角色声音。', languages: ['zh'], enabled: true, resource_id: config.volc.resourceId });
  }
  if (new Set(voices.map(v => v.id)).size !== voices.length) throw new DomainError('INVALID_CATALOG', '音色目录含重复 ID。');
  return voices.map(v => ({ ...v, provider: 'volcengine', availability: v.enabled ? 'configured' : 'unconfigured', source: existsSync(customPath) ? 'local account allowlist (provider permission unverified)' : 'bundled public candidates + local configuration (provider permission unverified)' }));
}

export function configuredVoice(config: Config, id: string) {
  const voice = listVoices(config).find(v => v.id === id && v.enabled);
  if (!voice) throw new DomainError('VOICE_UNAVAILABLE', '该音色未加入本地已开通目录。请先配置音色，再请求生成。');
  return voice;
}
