import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { FISH_MODELS } from './voice/fish.js';
import { ELEVEN_MODELS } from './voice/eleven.js';
import type { PublicSettings } from '../shared/protocol.js';

export const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

/** All user data lives here: config, chat history, audio, MEMORY.md/IDENTITY.md. */
export const defaultDataDir = () => process.env.FIND_MY_VOICE_HOME || resolve(homedir(), '.find-my-voice');

// Each voice provider keeps its own credentials, so switching back and forth loses nothing.
const volcengineSchema = z.object({
  apiKey: z.string().default(''),
  resourceId: z.string().default('seed-tts-2.0'),
  voiceId: z.string().default('zh_female_vv_uranus_bigtts'),
  /** Sent as `additions.explicit_language`; only some voices honour it. */
  language: z.enum(['auto', 'zh', 'en']).default('auto'),
}).strict();
const fishSchema = z.object({
  apiKey: z.string().default(''),
  /** A voice model id from fish.audio; empty uses Fish's default voice. */
  referenceId: z.string().default(''),
  model: z.enum(FISH_MODELS).default('s1'),
}).strict();
const elevenSchema = z.object({
  apiKey: z.string().default(''),
  /** A voice id from elevenlabs.io; empty falls back to a clear setup error. */
  voiceId: z.string().default(''),
  model: z.enum(ELEVEN_MODELS).default('eleven_v4'),
  /** `auto` infers the language from the text; `zh` / `en` force a normalizer. */
  language: z.enum(['auto', 'zh', 'en']).default('auto'),
  stability: z.number().min(0).max(1).default(0.5),
  similarity: z.number().min(0).max(1).default(0.8),
}).strict();

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
    provider: z.enum(['volcengine', 'fish', 'elevenlabs', 'fixture']).default('volcengine'),
    speechRate: z.number().int().min(-50).max(100).default(0),
    timeoutMs: z.number().int().min(1000).max(180000).default(45000),
    volcengine: volcengineSchema.prefault({}),
    fish: fishSchema.prefault({}),
    elevenlabs: elevenSchema.prefault({}),
  }).strict().prefault({}),
}).strict();

export type Settings = z.infer<typeof settingsSchema>;
type Group = keyof Settings;
type VoiceSettings = Settings['voice'];
export type SettingsPatch = { [K in Exclude<Group, 'voice'>]?: Partial<Settings[K]> } & {
  voice?: Partial<Omit<VoiceSettings, 'volcengine' | 'fish' | 'elevenlabs'>> & {
    volcengine?: Partial<VoiceSettings['volcengine']>;
    fish?: Partial<VoiceSettings['fish']>;
    elevenlabs?: Partial<VoiceSettings['elevenlabs']>;
  };
};

/**
 * What the browser may change. Every field is optional with NO defaults: a
 * default here would silently reset whatever the request did not mention.
 * Server and port are not editable from the page.
 */
export const settingsPatchSchema: z.ZodType<SettingsPatch> = z.object({
  companion: z.object({ name: z.string().trim().min(1).max(40) }).partial().strict().optional(),
  brain: z.object({ baseUrl: z.string(), apiKey: z.string(), model: z.string() }).partial().strict().optional(),
  voice: z.object({
    provider: z.enum(['volcengine', 'fish', 'elevenlabs', 'fixture']),
    speechRate: z.number().int().min(-50).max(100),
    volcengine: z.object({
      apiKey: z.string(), resourceId: z.string(), voiceId: z.string(), language: z.enum(['auto', 'zh', 'en']),
    }).partial().strict(),
    fish: z.object({ apiKey: z.string(), referenceId: z.string(), model: z.enum(FISH_MODELS) }).partial().strict(),
    elevenlabs: z.object({
      apiKey: z.string(), voiceId: z.string(), model: z.enum(ELEVEN_MODELS), language: z.enum(['auto', 'zh', 'en']),
      stability: z.number().min(0).max(1), similarity: z.number().min(0).max(1),
    }).partial().strict(),
  }).partial().strict().optional(),
}).strict();

/** Before multiple providers, Volcengine's fields sat directly on `voice`. */
function migrate(raw: unknown): { value: unknown; changed: boolean } {
  if (!raw || typeof raw !== 'object') return { value: raw, changed: false };
  const voice = (raw as { voice?: Record<string, unknown> }).voice;
  if (!voice || !('apiKey' in voice || 'resourceId' in voice || 'voiceId' in voice)) return { value: raw, changed: false };
  const { apiKey, resourceId, voiceId, ...rest } = voice;
  const volcengine = Object.fromEntries(Object.entries({ apiKey, resourceId, voiceId }).filter(([, v]) => v !== undefined));
  return { value: { ...raw, voice: { ...rest, volcengine: { ...volcengine, ...(rest.volcengine as object | undefined) } } }, changed: true };
}

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
  const migrated = migrate(raw);
  const parsed = settingsSchema.safeParse(migrated.value);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(i => i.path.join('.')))].join(', ');
    throw new Error(`配置文件格式无效：${path} — ${fields}`);
  }
  if (migrated.changed) writeAtomic(dir, parsed.data);
  return parsed.data;
}

/** Merges a patch per group (and per voice provider), validates, then writes. A bad patch never corrupts a working file. */
export function updateSettings(dir: string, patch: SettingsPatch): Settings {
  const current = loadSettings(dir);
  const { volcengine, fish, elevenlabs, ...voice } = patch.voice ?? {};
  const merged = {
    ...Object.fromEntries((Object.keys(current) as Group[]).map(group => [group, { ...current[group], ...patch[group] }])),
    voice: {
      ...current.voice, ...voice,
      volcengine: { ...current.voice.volcengine, ...volcengine },
      fish: { ...current.voice.fish, ...fish },
      elevenlabs: { ...current.voice.elevenlabs, ...elevenlabs },
    },
  };
  const next = settingsSchema.parse(merged);
  writeAtomic(dir, next);
  return next;
}

/** Settings safe to send to the browser: secrets reduced to presence flags. */
export function maskSettings(settings: Settings): PublicSettings {
  const { apiKey: brainKey, ...brain } = settings.brain;
  const {
    volcengine: { apiKey: volcKey, ...volcengine },
    fish: { apiKey: fishKey, ...fish },
    elevenlabs: { apiKey: elevenKey, ...elevenlabs },
    ...voice
  } = settings.voice;
  return {
    companion: settings.companion,
    brain: { ...brain, hasApiKey: Boolean(brainKey) },
    voice: {
      ...voice,
      volcengine: { ...volcengine, hasApiKey: Boolean(volcKey) },
      fish: { ...fish, hasApiKey: Boolean(fishKey) },
      elevenlabs: { ...elevenlabs, hasApiKey: Boolean(elevenKey) },
    },
  };
}
