// The demo script: what she says, writes and changes, beat by beat, for
// recording the walkthrough. Parsed once at launch; `{name}` is the user's name.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { PaperBlock } from '../../shared/protocol.js';
import { applyOps, nextBlockNumber, toBlocks } from '../papers/schema.js';

const language = z.enum(['auto', 'zh', 'en']);
// Blocks and ops stay loose: the paper schema is what checks them, as it does for the model.
const block = z.looseObject({ id: z.string().optional(), type: z.string() });
const op = z.looseObject({ op: z.string(), blockId: z.string().optional(), afterBlockId: z.string().nullable().optional() });

const paperCue = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'), id: z.string(), title: z.string(), blocks: z.array(block),
    /** The paper starts once she has said this much of her line. */
    startAfterText: z.string().optional(),
    /** A letter: the voice script makes her reading of it, and the paper gets a way to play it. */
    read: z.boolean().optional(),
  }),
  z.object({ action: z.literal('edit'), id: z.string(), ops: z.array(op) }),
  z.object({ action: z.literal('save'), id: z.string() }),
]);

const beat = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('her'), text: z.string().min(1), mood: z.string().optional(),
    paper: paperCue.optional(), setting: z.object({ replyLanguage: language }).optional(),
    proactive: z.boolean().optional(),
    /** Baked into the cached take by the voice script. */
    volume: z.number().min(0).max(2).optional(),
    /** A take recorded already, under web/public (one sentence): used as is, never synthesized. */
    audio: z.string().optional(),
    /** Her goodbye: once it is said she rests, and the room goes down. */
    rest: z.boolean().optional(),
    rate: z.number().int().min(-50).max(100).optional(),
  }),
  z.object({ type: z.literal('user'), userText: z.string().min(1) }),
  z.object({ type: z.literal('paper'), paper: paperCue }),
  z.object({
    type: z.literal('openApp'), app: z.enum(['papers', 'settings']), select: z.string().optional(),
    tab: z.enum(['appearance', 'brain', 'voice', 'her']).optional(),
  }),
  z.object({ type: z.literal('timelapse'), from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }), durationMs: z.number().int().positive() }),
  z.object({ type: z.literal('appLaunch') }),
]);

const scene = z.object({
  id: z.number().int(), name: z.string(),
  clock: z.iso.datetime({ offset: true }).optional(),
  /** Played by the real first meeting, its answers filled in from the preset. */
  onboarding: z.boolean().optional(),
  setup: z.object({ replyLanguage: language.optional() }).optional(),
  beats: z.array(beat).default([]),
});

const scriptSchema = z.object({
  preset: z.object({
    userName: z.string().min(1), herName: z.string().min(1), herNameReason: z.string().default(''),
    replyLanguage: language, uiLanguage: language, hideCursor: z.boolean().default(false),
    onboardingAnswers: z.object({
      comfort: z.enum(['listen', 'advise', 'cheer', 'depends']),
      rhythm: z.enum(['morning', 'commute', 'night', 'anytime']),
      onMind: z.string(),
    }),
    memory: z.array(z.object({ date: z.string(), text: z.string() })).default([]),
    papers: z.array(z.object({
      id: z.string(), title: z.string(), createdAt: z.iso.datetime({ offset: true }),
      savedAt: z.iso.datetime({ offset: true }).optional(), blocks: z.array(block),
      /** A letter: the voice script makes her reading of it, and the paper gets a way to play it. */
      read: z.boolean().optional(),
    })).default([]),
  }),
  timing: z.object({
    /** A fixed wait, or [min, max] for a different one every time, the way someone takes a moment before answering. */
    replyDelayMs: z.union([z.number().int().min(0).transform(ms => [ms, ms] as const), z.tuple([z.number().int().min(0), z.number().int().min(0)])])
      .default([1000, 2000]),
    pauseAfterBeatMs: z.number().int().min(0).default(400),
    paperWritingCharsPerSecond: z.number().positive().default(16),
  }),
  scenes: z.array(scene).min(1),
});

export type DemoScript = z.infer<typeof scriptSchema>;
export type DemoScene = DemoScript['scenes'][number];
export type DemoBeat = DemoScene['beats'][number];
export type PaperCue = z.infer<typeof paperCue>;
export type HerBeat = Extract<DemoBeat, { type: 'her' }>;

const fill = (value: unknown, name: string): unknown =>
  typeof value === 'string' ? value.replaceAll('{name}', name)
    : Array.isArray(value) ? value.map(v => fill(v, name))
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, name)]))
        : value;

export function parseDemo(raw: unknown, name: string): DemoScript {
  const parsed = scriptSchema.safeParse(fill(raw, name));
  if (!parsed.success) throw new Error(`演示脚本格式不对：${parsed.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  return parsed.data;
}

export const loadDemo = (path: string, name: string) => parseDemo(JSON.parse(readFileSync(path, 'utf8')), name);

/** The scene that is the first meeting; the one before it, if any, is an opening shot. */
export const meetingIndex = (script: DemoScript) => script.scenes.findIndex(s => s.onboarding);

/** Her lines and her papers run on from one another without a key press. */
export const isHers = (beat: DemoBeat | undefined) => beat?.type === 'her' || beat?.type === 'paper';

/** Where the run of hers starting at `from` ends (exclusive). */
export function runEnd(beats: DemoBeat[], from: number) {
  let end = from;
  while (isHers(beats[end])) end++;
  return end;
}

/** The beats the script waits at: everything but the second and later of her lines in a row. */
export const stops = (beats: DemoBeat[]) => beats.flatMap((beat, i) => (isHers(beat) && isHers(beats[i - 1]) ? [] : [i]));

/** Script block ids are for people reading the script; the paper numbers them b1… in order, so an edit is mapped by position. */
export function blockIds(cue: Extract<PaperCue, { action: 'create' }>) {
  return new Map(cue.blocks.flatMap((b, i) => (b.id ? [[b.id, `b${i + 1}`] as const] : [])));
}

export function mapOps(ops: Extract<PaperCue, { action: 'edit' }>['ops'], ids: Map<string, string>) {
  const map = (id: string | null | undefined) => (id ? ids.get(id) ?? id : id);
  return ops.map(o => ({ ...o, ...(o.blockId ? { blockId: map(o.blockId) } : {}), ...(o.afterBlockId ? { afterBlockId: map(o.afterBlockId) } : {}) }));
}

/** The blocks as written, without the script's own ids. */
export const bareBlocks = (blocks: Extract<PaperCue, { action: 'create' }>['blocks']) => blocks.map(({ id: _id, ...rest }) => rest);

const cueOf = (beat: DemoBeat) => (beat.type === 'her' || beat.type === 'paper' ? beat.paper : undefined);

export type DemoPaper = { id: string; title: string; blocks: PaperBlock[]; createdAt: string; saved: boolean };

/** Every paper the scenes before `sceneIndex` leave behind, as they leave it. */
export function papersBefore(script: DemoScript, sceneIndex: number): DemoPaper[] {
  const papers = new Map<string, DemoPaper & { ids: Map<string, string> }>();
  let clock = script.scenes[0]?.clock ?? new Date().toISOString();
  for (const scene of script.scenes.slice(0, sceneIndex)) {
    clock = scene.clock ?? clock;
    for (const cue of scene.beats.map(cueOf)) {
      if (!cue) continue;
      const paper = papers.get(cue.id);
      if (cue.action === 'create') {
        papers.set(cue.id, { id: cue.id, title: cue.title, blocks: toBlocks(bareBlocks(cue.blocks)), createdAt: clock, saved: false, ids: blockIds(cue) });
      } else if (paper && cue.action === 'edit') {
        papers.set(cue.id, { ...paper, blocks: applyOps(paper.blocks, mapOps(cue.ops, paper.ids), nextBlockNumber(paper.blocks)).blocks });
      } else if (paper) {
        papers.set(cue.id, { ...paper, saved: true });
      }
    }
  }
  return [...papers.values()].map(({ ids: _ids, ...paper }) => paper);
}

/** The reply language a scene opens with: the preset, every change she was asked for before it, then its own setup. */
export function languageAt(script: DemoScript, sceneIndex: number) {
  let current = script.preset.replyLanguage;
  for (const [i, scene] of script.scenes.slice(0, sceneIndex + 1).entries()) {
    current = scene.setup?.replyLanguage ?? current;
    if (i === sceneIndex) break;
    for (const beat of scene.beats) if (beat.type === 'her' && beat.setting) current = beat.setting.replyLanguage;
  }
  return current;
}

/** Every line she says in the script, with how it should be read. */
export function herLines(script: DemoScript) {
  return script.scenes.flatMap(scene => scene.beats.flatMap(beat => (beat.type === 'her' ? [beat] : [])));
}

/** The papers she reads aloud, with what she reads: every paragraph, the title left out.
 * A preset paper joins them when the script says `read` on it — written ahead of the
 * recording, it still gets her reading. */
export function letters(script: DemoScript) {
  // Blocks stay loose (the paper schema checks them), so this reads one by its `text`.
  const ofCue = (id: string, blocks: readonly { [key: string]: unknown }[], read: boolean) =>
    read ? [{ id, paragraphs: blocks.flatMap(b => (typeof b.text === 'string' && b.text.trim() ? [b.text.trim()] : [])) }] : [];
  return [
    ...script.preset.papers.flatMap(p => ofCue(p.id, p.blocks, Boolean(p.read))),
    ...script.scenes.flatMap(scene => scene.beats.flatMap(beat => {
      const cue = beat.type === 'her' || beat.type === 'paper' ? beat.paper : undefined;
      if (cue?.action !== 'create') return [];
      return ofCue(cue.id, cue.blocks, Boolean(cue.read));
    })),
  ];
}

/** How long she waits this time before she answers. */
export const replyDelay = ([min, max]: readonly [number, number]) => min + Math.random() * Math.max(0, max - min);

/** HH:MM in the time zone the script was written in, so the light matches the clock it names. */
export const clockTime = (iso: string) => /T(\d{2}:\d{2})/.exec(iso)?.[1] ?? '00:00';
