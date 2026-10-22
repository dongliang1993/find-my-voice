import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { PublicSettings } from '../shared/protocol.js';

export const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

/** All user data lives here: config, chat history, audio, MEMORY.md/IDENTITY.md. */
export const defaultDataDir = () => process.env.FIND_MY_VOICE_HOME || resolve(homedir(), '.find-my-voice');

export const settingsSchema = z.object({
  server: z.object({
    host: z.enum(['127.0.0.1', 'localhost', '::1']).default('127.0.0.1'),
    port: z.number().int().min(0).max(65535).default(3210),
  }).strict().prefault({}),
  companion: z.object({
    name: z.string().trim().min(1).max(40).default('Vivi'),
  }).strict().prefault({}),
  // Empty values mean "inherit from Claude Code or the environment".
  brain: z.object({
    baseUrl: z.string().default(''),
    apiKey: z.string().default(''),
    model: z.string().default(''),
  }).strict().prefault({}),
  voice: z.object({
    provider: z.enum(['volcengine', 'fixture']).default('volcengine'),
    apiKey: z.string().default(''),
    resourceId: z.string().default('seed-tts-2.0'),
    voiceId: z.string().default('zh_female_vv_uranus_bigtts'),
    speechRate: z.number().int().min(-50).max(100).default(0),
    timeoutMs: z.number().int().min(1000).max(180000).default(45000),
  }).strict().prefault({}),
}).strict();

export type Settings = z.infer<typeof settingsSchema>;
type Group = keyof Settings;
export type SettingsPatch = { [K in Group]?: Partial<Settings[K]> };

const configPath = (dir: string) => resolve(dir, 'config.json');

function writeAtomic(dir: string, settings: Settings) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = configPath(dir); const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/** Reads config, creating defaults on first run. Throws on a malformed file rather than resetting it. */
export function loadSettings(dir = defaultDataDir()): Settings {
  const path = configPath(dir);
  if (!existsSync(path)) {
    const defaults = settingsSchema.parse({});
    writeAtomic(dir, defaults);
    return defaults;
  }
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`配置文件无法解析：${path}（不会自动覆盖，修正后重试）`); }
  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(i => i.path.join('.')))].join(', ');
    throw new Error(`配置文件格式无效：${path} — ${fields}`);
  }
  return parsed.data;
}

/** Merges a patch per group, validates, then writes. A bad patch never corrupts a working file. */
export function updateSettings(dir: string, patch: SettingsPatch): Settings {
  const current = loadSettings(dir);
  const merged = Object.fromEntries((Object.keys(current) as Group[])
    .map(group => [group, { ...current[group], ...patch[group] }]));
  const next = settingsSchema.parse(merged);
  writeAtomic(dir, next);
  return next;
}

/** Settings safe to send to the browser: secrets reduced to presence flags. */
export function maskSettings(settings: Settings): PublicSettings {
  const { apiKey: brainKey, ...brain } = settings.brain;
  const { apiKey: voiceKey, ...voice } = settings.voice;
  return { companion: settings.companion, brain: { ...brain, hasApiKey: Boolean(brainKey) }, voice: { ...voice, hasApiKey: Boolean(voiceKey) } };
}
