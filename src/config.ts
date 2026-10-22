import { existsSync, mkdirSync, chmodSync, readFileSync, renameSync, writeFileSync, watch, type FSWatcher } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

// settings.json is the single source of truth for every setting. Its own
// location cannot come from it, so the only environment input left is
// PLUGIN_DATA (tests and unusual layouts); everything else lives in the file.
const settingsPath = () => resolve(process.env.PLUGIN_DATA || resolve(projectRoot, 'data'), 'settings.json');

export const settingsSchema = z.object({
  server: z.object({
    host: z.enum(['127.0.0.1', 'localhost', '::1']).default('127.0.0.1'),
    port: z.coerce.number().int().min(0).max(65535).default(3210),
  }).strict().default({}),
  owner: z.object({ id: z.string().min(1).default('local-owner') }).strict().default({}),
  // Guards the HTTP /mcp route only; the stdio entry does not use it.
  tokens: z.object({
    mcp: z.string().min(32), signingKey: z.string().min(32),
  }).strict(),
  provider: z.object({
    type: z.enum(['fixture', 'volcengine']).default('fixture'),
    apiKey: z.string().default(''), appId: z.string().default(''), accessKey: z.string().default(''),
    resourceId: z.string().default(''), defaultVoice: z.string().default(''), defaultVoiceName: z.string().default(''),
    apiMode: z.enum(['tts', 'seed-audio']).default('tts'),
  }).strict().default({}),
  voice: z.object({
    replyMode: z.enum(['explicit', 'adaptive']).default('explicit'),
    localPlayback: z.enum(['none', 'stream']).default('none'),
  }).strict().default({}),
  limits: z.object({
    timeoutMs: z.coerce.number().int().min(100).max(180000).default(45000),
    seedAudioTimeoutMs: z.coerce.number().int().min(100).max(300000).default(300000),
    maxCharacters: z.coerce.number().int().min(1).max(2000).default(500),
    maxConcurrency: z.coerce.number().int().min(1).max(10).default(2),
    requestsPerMinute: z.coerce.number().int().min(1).max(120).default(10),
    retentionDays: z.coerce.number().min(0.001).max(365).default(7),
    linkMinutes: z.coerce.number().min(1).max(1440).default(30),
  }).strict().default({}),
}).strict();
export type Settings = z.infer<typeof settingsSchema>;

// Patch shape: every field optional *without* defaults, so a partial update
// does not silently reset the fields it did not mention. Built from the same
// objects, so the two cannot drift apart.
const patchable = (group: z.ZodTypeAny) => {
  const shape = (group instanceof z.ZodDefault ? group.removeDefault() : group as z.ZodObject<z.ZodRawShape>).shape;
  return z.object(Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, (value as z.ZodTypeAny).optional()]))).strict();
};
export const settingsPatchSchema = z.object({
  server: patchable(settingsSchema.shape.server).optional(),
  owner: patchable(settingsSchema.shape.owner).optional(),
  tokens: patchable(settingsSchema.shape.tokens).optional(),
  provider: patchable(settingsSchema.shape.provider).optional(),
  voice: patchable(settingsSchema.shape.voice).optional(),
  limits: patchable(settingsSchema.shape.limits).optional(),
}).strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export type Config = ReturnType<typeof buildConfig>;

function buildConfig(s: Settings, root: string) {
  return {
    host: s.server.host, port: s.server.port, root, dataDir: dirname(settingsPath()),
    ownerId: s.owner.id, mcpToken: s.tokens.mcp, signingKey: s.tokens.signingKey,
    provider: s.provider.type, apiMode: s.provider.apiMode, seedAudioTimeoutMs: s.limits.seedAudioTimeoutMs,
    voiceReplyMode: s.voice.replyMode, localAudioPlayback: s.voice.localPlayback,
    volc: { apiKey: s.provider.apiKey, appId: s.provider.appId, accessKey: s.provider.accessKey, resourceId: s.provider.resourceId },
    bootstrapVoice: s.provider.defaultVoice, bootstrapVoiceName: s.provider.defaultVoiceName,
    timeoutMs: s.limits.timeoutMs, maxCharacters: s.limits.maxCharacters,
    maxConcurrency: s.limits.maxConcurrency, requestsPerMinute: s.limits.requestsPerMinute,
    retentionMs: s.limits.retentionDays * 86400000, linkMs: s.limits.linkMinutes * 60000,
  };
}

/** Parsed settings. Throws on a malformed file rather than silently defaulting. */
export function readSettings(): Settings {
  const path = settingsPath();
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`缺少设置文件 ${path}；运行 npm run init 生成。`);
    throw new Error(`设置文件无法解析：${path}。（不会自动覆盖，修正后重试）`);
  }
  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`设置文件格式无效：${path} — ${[...new Set(parsed.error.issues.map(i => i.path.join('.')))].join(', ')}`);
  return parsed.data;
}

/** Writes the file and returns what was written. Atomic, 0600 because it holds secrets. */
export function writeSettings(settings: Settings) {
  const path = settingsPath(); const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  return settings;
}

/** Deep merge by group, so one form can save without resending everything. */
export function mergeSettings(patch: DeepPartial<Settings>): Settings {
  const current = readSettings();
  const merged = { ...current } as Record<string, unknown>;
  for (const [group, values] of Object.entries(patch)) {
    if (values === undefined) continue;
    merged[group] = { ...(current[group as keyof Settings] as object), ...values };
  }
  // Validate before writing so a bad patch cannot corrupt a working file.
  return writeSettings(settingsSchema.parse(merged));
}
export type DeepPartial<T> = { [K in keyof T]?: Partial<T[K]> };

/** Creates the file with fresh tokens on first run; never touches an existing one. */
export function ensureSettings() {
  const path = settingsPath();
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeSettings(settingsSchema.parse({ tokens: {
    mcp: randomBytes(32).toString('hex'), signingKey: randomBytes(32).toString('hex'),
  } }));
}

/** Fresh read on every call, so a changed file is picked up without a restart. */
export function loadConfig() {
  ensureSettings();
  const config = buildConfig(readSettings(), projectRoot);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(config.dataDir, 0o700);
  return config;
}

/** Applies a patch and returns the new config. Callers replace their reference. */
export function applySettings(patch: DeepPartial<Settings>) {
  mergeSettings(patch);
  return loadConfig();
}

/**
 * Hot reload. Watches the settings file and reports the rebuilt config.
 * Debounced: editors emit several events per save and writeSettings renames.
 */
export function watchSettings(onChange: (config: Config) => void, onError: (error: Error) => void): FSWatcher {
  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(dirname(settingsPath()), (_event, file) => {
    if (file && file !== 'settings.json') return;
    clearTimeout(timer);
    timer = setTimeout(() => { try { onChange(loadConfig()); } catch (error) { onError(error as Error); } }, 120);
  });
  watcher.unref();
  return watcher;
}
