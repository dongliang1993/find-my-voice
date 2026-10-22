import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
export const requestId = text(128).regex(/^[a-zA-Z0-9_-]+$/).min(8);
export const roleId = z.literal('default').default('default');
export const profileWriteSchema = z.object({
  document: z.enum(['memory', 'identity']),
  content: z.string().min(1).max(131072).describe('宿主 Agent 根据获授权历史生成或合并的完整 Markdown 正文，不含密钥。'),
  base_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().describe('更新前读取的文档 SHA-256；仅新建文件时传 null，防止覆盖并发修改。'),
}).strict();
// Owner-page credential entry. All fields optional so one field can be edited
// without resending the rest; the service merges and normalises the pair.
// The shape itself lives in config.ts next to the file it persists.
export const memoryEntry = z.object({
  kind: z.enum(['shared_experience', 'discussion', 'disagreement', 'preference']),
  content: text(1500),
  source: text(1000).describe('真实消息、用户提供材料的编号或可核对的来源说明。'),
  participant: z.enum(['user', 'assistant', 'both']),
  is_inference: z.boolean().default(false),
}).strict();
export const memorySaveSchema = z.object({
  request_id: requestId, role_id: roleId,
  entries: z.array(memoryEntry).min(1).max(20),
}).strict();

export const identity = z.object({
  display_name: text(80),
  expression_principles: z.array(text(500)).min(1).max(12),
  traits: z.array(z.object({
    name: text(80), description: text(1000), evidence: z.array(text(1000)).min(1).max(8),
  }).strict()).max(12),
  disagreement_style: text(1500),
  relationship_position: text(1000),
  uncertainties: z.array(text(500)).max(12),
}).strict();
export const voiceConfiguration = z.object({
  voice_id: text(160).regex(/^[a-zA-Z0-9_-]+$/),
  reason: text(1500),
  assessment_basis: z.enum(['description', 'user_feedback', 'audio_analysis']),
  evidence: z.array(text(1000)).min(1).max(8),
  speech_rate: z.number().int().min(-50).max(100).default(0),
  loudness_rate: z.number().int().min(-50).max(100).default(0),
}).strict();
export const identityUpdateSchema = z.object({
  request_id: requestId, role_id: roleId,
  base_version: z.number().int().min(0),
  identity: identity.optional(), voice: voiceConfiguration.optional(),
  change_reason: text(2000), memory_ids: z.array(z.string().uuid()).max(40).default([]),
}).strict().refine(v => v.identity || v.voice, '至少提供 identity 或 voice。');
export const voiceListSchema = z.object({
  language: z.enum(['zh', 'en']).optional(),
  include_unconfigured: z.boolean().default(false),
}).strict();
export const voiceSpeakSchema = z.object({
  request_id: requestId, role_id: roleId,
  text: text(4000).describe('实际朗读的口语文本；服务端另有可配置字符上限。'),
  playback: z.enum(['none', 'stream']).optional().describe('stream 在本地 stdio 宿主边接收 PCM 边播放；none 仅生成文件。远程 HTTP 不支持本机播放。'),
  generation_mode: z.enum(['tts', 'seed-audio']).optional().describe('tts 用于固定音色朗读；seed-audio 用于声音风格实验。'),
  speech_direction: text(500).optional().describe('Seed Audio 的自然语言声音描述。无固定音色时必填；TTS 模式不支持此字段。'),
  voice_id: text(160).regex(/^[a-zA-Z0-9_-]+$/).optional().describe('临时试听覆盖，不改写默认声音。'),
  speech_rate: z.number().int().min(-50).max(100).optional(),
  loudness_rate: z.number().int().min(-50).max(100).optional(),
}).strict();

export type MemoryEntry = z.infer<typeof memoryEntry>;
export type MemorySave = z.infer<typeof memorySaveSchema>;
export type Identity = z.infer<typeof identity>;
export type VoiceConfiguration = z.infer<typeof voiceConfiguration>;
export type IdentityUpdate = z.infer<typeof identityUpdateSchema>;
export type VoiceSpeak = z.infer<typeof voiceSpeakSchema>;
