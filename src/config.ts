import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const envSchema = z.object({
  HOST: z.enum(['127.0.0.1', 'localhost', '::1']).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3210),
  PUBLIC_BASE_URL: z.string().default(''),
  DATA_DIR: z.string().default('./data'),
  OWNER_ID: z.string().min(1).default('local-owner'),
  ADMIN_TOKEN: z.string().min(32),
  MCP_TOKEN: z.string().min(32),
  MEDIA_SIGNING_KEY: z.string().min(32),
  TTS_PROVIDER: z.enum(['volcengine', 'fixture']).default('volcengine'),
  VOICE_REPLY_MODE: z.enum(['explicit', 'adaptive']).default('explicit'),
  LOCAL_AUDIO_PLAYBACK: z.enum(['none', 'stream']).default('none'),
  VOLC_API_MODE: z.enum(['tts', 'seed-audio']).default('tts'),
  SEED_AUDIO_TIMEOUT_MS: z.coerce.number().int().min(100).max(300000).default(300000),
  VOLC_API_KEY: z.string().default(''),
  VOLC_APP_ID: z.string().default(''),
  VOLC_ACCESS_KEY: z.string().default(''),
  VOLC_RESOURCE_ID: z.string().default(''),
  VOLC_DEFAULT_VOICE: z.string().default(''),
  VOLC_DEFAULT_VOICE_NAME: z.string().default(''),
  TTS_TIMEOUT_MS: z.coerce.number().int().min(100).max(180000).default(45000),
  TTS_MAX_CHARACTERS: z.coerce.number().int().min(1).max(2000).default(500),
  TTS_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(2),
  TTS_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(120).default(10),
  AUDIO_RETENTION_DAYS: z.coerce.number().min(0.001).max(365).default(7),
  MEDIA_LINK_MINUTES: z.coerce.number().min(1).max(1440).default(30),
});
export type Config = ReturnType<typeof parseConfig>;

export function parseConfig(env: Record<string, string | undefined>, root = projectRoot) {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`配置无效：${[...new Set(result.error.issues.map(i => i.path.join('.')))].join(', ')}。请运行 npm run init 并检查 .env。`);
  }
  const e = result.data;
  const url = e.PUBLIC_BASE_URL ? new URL(e.PUBLIC_BASE_URL) : undefined;
  if (url && (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')) {
    throw new Error('PUBLIC_BASE_URL 必须是无凭证、路径、查询参数的 HTTPS origin。');
  }
  return {
    host: e.HOST, port: e.PORT, publicBaseUrl: url?.origin,
    root, dataDir: resolve(root, env.PLUGIN_DATA || e.DATA_DIR), ownerId: e.OWNER_ID,
    adminToken: e.ADMIN_TOKEN, mcpToken: e.MCP_TOKEN, signingKey: e.MEDIA_SIGNING_KEY,
    provider: e.TTS_PROVIDER, apiMode: e.VOLC_API_MODE, seedAudioTimeoutMs: e.SEED_AUDIO_TIMEOUT_MS,
    voiceReplyMode: e.VOICE_REPLY_MODE, localAudioPlayback: e.LOCAL_AUDIO_PLAYBACK,
    volc: { apiKey: e.VOLC_API_KEY, appId: e.VOLC_APP_ID, accessKey: e.VOLC_ACCESS_KEY, resourceId: e.VOLC_RESOURCE_ID },
    bootstrapVoice: e.VOLC_DEFAULT_VOICE, bootstrapVoiceName: e.VOLC_DEFAULT_VOICE_NAME,
    timeoutMs: e.TTS_TIMEOUT_MS, maxCharacters: e.TTS_MAX_CHARACTERS,
    maxConcurrency: e.TTS_MAX_CONCURRENCY, requestsPerMinute: e.TTS_REQUESTS_PER_MINUTE,
    retentionMs: e.AUDIO_RETENTION_DAYS * 86400000, linkMs: e.MEDIA_LINK_MINUTES * 60000,
  };
}

export function loadConfig() {
  const path = resolve(projectRoot, '.env');
  if (existsSync(path)) loadEnvFile(path);
  const config = parseConfig(process.env);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(config.dataDir, 0o700);
  return config;
}
