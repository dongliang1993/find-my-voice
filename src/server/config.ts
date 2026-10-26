import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { FISH_MODELS } from './voice/fish.js';
import { ELEVEN_MODELS } from './voice/eleven.js';
import type { PublicSettings, Rhythm } from '../shared/protocol.js';

export const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

/** All user data lives here: config, chat history, audio, MEMORY.md/IDENTITY.md. */
export const defaultDataDir = () => process.env.FIND_MY_VOICE_HOME || resolve(homedir(), '.find-my-voice');

// Each voice provider keeps its own credentials, so switching back and forth loses nothing.
const volcengineSchema = z.object({
  apiKey: z.string().default(''),
  resourceId: z.string().default('seed-tts-2.0'),
  voiceId: z.string().default('zh_female_vv_uranus_bigtts'),
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
  stability: z.number().min(0).max(1).default(0.5),
  similarity: z.number().min(0).max(1).default(0.8),
  /**
   * Speaker boost tracks the stored voice closer, at a measured latency cost —
   * the one knob worth turning off when a flash model is chasing milliseconds.
   */
  speakerBoost: z.boolean().default(true),
}).strict();

export const settingsSchema = z.object({
  server: z.object({
    host: z.enum(['127.0.0.1', 'localhost', '::1']).default('127.0.0.1'),
    port: z.number().int().min(0).max(65535).default(3210),
  }).strict().prefault({}),
  companion: z.object({
    name: z.string().trim().min(1).max(40).default('Vivi'),
    /** How she addresses the user; empty means she has not been told yet. */
    userName: z.string().trim().max(40).default(''),
    /** How to meet a bad mood, from the first meeting. */
    comfort: z.enum(['listen', 'advise', 'cheer', 'depends']).default('depends'),
    /** When the user tends to want company; `anytime` lets her pick her own hours. */
    rhythm: z.enum(['morning', 'commute', 'night', 'anytime']).default('anytime'),
    /**
     * What she writes in — and therefore what she is read in: `auto` mirrors the
     * user, `zh` / `en` hold whatever they write. Drives both the prompt and the
     * TTS language hint, so the two can never disagree.
     */
    language: z.enum(['auto', 'zh', 'en']).default('auto'),
    /**
     * Voice-first: she answers out loud unless something is better read than
     * heard. Off, she types and only speaks when the words want a voice.
     */
    voiceFirst: z.boolean().default(false),
  }).strict().prefault({}),
  // The app's own words. English until said otherwise; `auto` follows the system.
  ui: z.object({
    language: z.enum(['auto', 'zh', 'en']).default('en'),
  }).strict().prefault({}),
  // Empty values mean "inherit from Claude Code or the environment".
  brain: z.object({
    baseUrl: z.string().default(''),
    apiKey: z.string().default(''),
    model: z.string().default(''),
  }).strict().prefault({}),
  // When and how often she may speak first. Local hours; quiet hours may wrap midnight.
  // `mode` is the only writable choice; the knobs are derived from it and are
  // what the gate reads. They are never persisted as independent defaults.
  initiative: z.object({
    mode: z.enum(['off', 'occasional', 'often']).default('occasional'),
    enabled: z.boolean().optional(),
    quietStart: z.number().int().min(0).max(23).optional(),
    quietEnd: z.number().int().min(0).max(23).optional(),
    dailyLimit: z.number().int().min(0).max(10).optional(),
    cooldownMinutes: z.number().int().min(10).max(1440).optional(),
    /** A window that never matches: morning greetings stay off. */
    morningStart: z.number().int().min(0).max(23).optional(),
    morningEnd: z.number().int().min(0).max(23).optional(),
    /** macOS notification when she speaks first. */
    notify: z.boolean().default(true),
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
  companion: z.object({
    name: z.string().trim().min(1).max(40), userName: z.string().trim().max(40),
    comfort: z.enum(['listen', 'advise', 'cheer', 'depends']), rhythm: z.enum(['morning', 'commute', 'night', 'anytime']),
    language: z.enum(['auto', 'zh', 'en']), voiceFirst: z.boolean(),
  }).partial().strict().optional(),
  ui: z.object({ language: z.enum(['auto', 'zh', 'en']) }).partial().strict().optional(),
  brain: z.object({ baseUrl: z.string(), apiKey: z.string(), model: z.string() }).partial().strict().optional(),
  initiative: z.object({
    mode: z.enum(['off', 'occasional', 'often']), notify: z.boolean(),
  }).partial().strict().optional(),
  voice: z.object({
    provider: z.enum(['volcengine', 'fish', 'elevenlabs', 'fixture']),
    speechRate: z.number().int().min(-50).max(100),
    volcengine: z.object({
      apiKey: z.string(), resourceId: z.string(), voiceId: z.string(),
    }).partial().strict(),
    fish: z.object({ apiKey: z.string(), referenceId: z.string(), model: z.enum(FISH_MODELS) }).partial().strict(),
    elevenlabs: z.object({
      apiKey: z.string(), voiceId: z.string(), model: z.enum(ELEVEN_MODELS),
      stability: z.number().min(0).max(1), similarity: z.number().min(0).max(1), speakerBoost: z.boolean(),
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

/**
 * Each voice provider used to hold its own reading-language hint. It is now one
 * setting on the companion, because the reading language is just the reply
 * language. The stored keys are dropped; `auto` is the new default, so an
 * install that had a language forced loses it — the provider fallback guesses
 * from the text, which is right whenever the two would have agreed anyway.
 */
function migrateVoiceLanguage(raw: unknown): { value: unknown; changed: boolean } {
  if (!raw || typeof raw !== 'object') return { value: raw, changed: false };
  const voice = (raw as { voice?: Record<string, unknown> }).voice;
  if (!voice || typeof voice !== 'object') return { value: raw, changed: false };
  const { volcengine, fish, elevenlabs, ...rest } = voice as Record<string, Record<string, unknown> | undefined>;
  const strip = (provider: Record<string, unknown> | undefined) => {
    if (!provider || !('language' in provider)) return { provider, dropped: false };
    const { language: _language, ...kept } = provider;
    return { provider: kept, dropped: true };
  };
  const volc = strip(volcengine), el = strip(elevenlabs);
  if (!volc.dropped && !el.dropped) return { value: raw, changed: false };
  return {
    value: { ...raw, voice: { ...rest, ...(volc.provider ? { volcengine: volc.provider } : {}), ...(fish ? { fish } : {}), ...(el.provider ? { elevenlabs: el.provider } : {}) } },
    changed: true,
  };
}

/**
 * Before the three-mode choice, initiative was stored as raw knobs. Existing
 * installs map to the nearest mode rather than failing to load; the knob
 * values themselves are dropped, because `mode` now decides them.
 */
const LEGACY_MODE = { off: 'off', occasional: 'occasional', often: 'often' } as const;
function migrateInitiative(raw: unknown): { value: unknown; changed: boolean } {
  if (!raw || typeof raw !== 'object') return { value: raw, changed: false };
  const initiative = (raw as { initiative?: Record<string, unknown> }).initiative;
  if (!initiative || initiative.mode !== undefined) return { value: raw, changed: false };
  const { enabled, dailyLimit, cooldownMinutes, missYouHours: _missYouHours, morningStart, ...rest } = initiative;
  let mode: (typeof LEGACY_MODE)[keyof typeof LEGACY_MODE];
  if (enabled === false || dailyLimit === 0) mode = 'off';
  else if (morningStart !== undefined && Number(morningStart) < 12) mode = 'often';
  else mode = 'occasional';
  return { value: { ...raw, initiative: { ...rest, mode } }, changed: true };
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
  // Each migrator returns {value, changed}; chain them value-to-value so the
  // wrapper never becomes the thing the schema parses.
  const m1 = migrate(raw);
  const m2 = migrateVoiceLanguage(m1.value);
  const m3 = migrateInitiative(m2.value);
  const migrated = { value: m3.value, changed: m1.changed || m2.changed || m3.changed };
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

/**
 * What `initiative.mode` maps to. The knobs are the only thing the gate ever
 * sees; the mapping lives here, next to the mode that drives it, so the two
 * cannot drift apart. Shared hours stay put across modes; only the mode
 * actually changes behavior.
 */
export type InitiativeMode = 'off' | 'occasional' | 'often';
export type ResolvedInitiative = {
  mode: InitiativeMode;
  enabled: boolean;
  quietStart: number; quietEnd: number;
  dailyLimit: number; cooldownMinutes: number;
  /** Local hours of her greeting window; `null, null` means it never matches. */
  rhythmStart: number | null; rhythmEnd: number | null;
  /** Days between two echoes; null, never. */
  echoGapDays: number | null;
  notify: boolean;
  /** Set once she has been left hanging: only something she remembered may interrupt. */
  followupsOnly?: boolean;
  /** Set after more silence still: she says nothing until the user comes back. */
  silent?: boolean;
};

/**
 * After this many unanswered openings she stops talking into the silence and
 * waits for the user to come back. She steps forward again one level per day
 * the user talks to her (the scheduler keeps that count).
 */
const SILENT_AFTER = 3;

/** Quiet hours apply in every mode that is on at all. */
const QUIET = { quietStart: 23, quietEnd: 8 };
const MODE_KNOBS: Record<InitiativeMode, Pick<ResolvedInitiative,
  'enabled' | 'dailyLimit' | 'cooldownMinutes' | 'rhythmStart' | 'rhythmEnd' | 'echoGapDays'
>> = {
  // Off: she never speaks first, whatever else is configured.
  off: { enabled: false, dailyLimit: 0, cooldownMinutes: 1440, rhythmStart: null, rhythmEnd: null, echoGapDays: null },
  // Occasional: at most a couple of unprompted turns a day, never a greeting on the hour,
  // and a line that stayed with her rarely.
  occasional: { enabled: true, dailyLimit: 2, cooldownMinutes: 360, rhythmStart: null, rhythmEnd: null, echoGapDays: 5 },
  // Often: daily-limit up, cooldown down, and a greeting in the hours the user likes company.
  often: { enabled: true, dailyLimit: 5, cooldownMinutes: 120, rhythmStart: 8, rhythmEnd: 11, echoGapDays: 3 },
};

/**
 * The hours the first meeting said the user wants company. `anytime` has no
 * opinion, so the mode's own windows stand.
 */
export const RHYTHM_HOURS: Record<Rhythm, { rhythmStart: number; rhythmEnd: number; quietStart: number; quietEnd: number } | null> = {
  morning: { rhythmStart: 7, rhythmEnd: 10, quietStart: 23, quietEnd: 6 },
  commute: { rhythmStart: 17, rhythmEnd: 20, quietStart: 23, quietEnd: 8 },
  night: { rhythmStart: 21, rhythmEnd: 23, quietStart: 3, quietEnd: 11 },
  anytime: null,
};

/**
 * The knobs derived from the stored mode. Individual knob overrides are
 * ignored. A rhythm chosen in the first meeting replaces the quiet and greeting
 * hours; `off` still wins over both.
 *
 * `unanswered` is how many times in a row she has opened and been left hanging.
 * The mode is a ceiling, never a floor: being ignored only ever makes her
 * quieter, and each day the user comes back puts her one step closer to it.
 */
export function resolveInitiative(initiative: Settings['initiative'], rhythm: Rhythm = 'anytime', unanswered = 0): ResolvedInitiative {
  const knobs = MODE_KNOBS[initiative.mode];
  const hours = RHYTHM_HOURS[rhythm];
  const base: ResolvedInitiative = !hours ? { mode: initiative.mode, ...QUIET, ...knobs, notify: initiative.notify } : {
    mode: initiative.mode, ...knobs, notify: initiative.notify,
    quietStart: hours.quietStart, quietEnd: hours.quietEnd,
    // A mode with no greeting (off, occasional) keeps none, whatever the rhythm.
    rhythmStart: knobs.rhythmStart === null ? null : hours.rhythmStart,
    rhythmEnd: knobs.rhythmEnd === null ? null : hours.rhythmEnd,
  };
  if (!base.enabled || unanswered <= 0) return base;
  return unanswered >= SILENT_AFTER
    ? { ...base, silent: true }
    : { ...base, followupsOnly: true };
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
    ui: settings.ui,
    initiative: resolveInitiative(settings.initiative, settings.companion.rhythm),
    brain: { ...brain, hasApiKey: Boolean(brainKey) },
    voice: {
      ...voice,
      volcengine: { ...volcengine, hasApiKey: Boolean(volcKey) },
      fish: { ...fish, hasApiKey: Boolean(fishKey) },
      elevenlabs: { ...elevenlabs, hasApiKey: Boolean(elevenKey) },
    },
  };
}
