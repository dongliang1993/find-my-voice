// The pen: how a letter comes onto the paper. The model writes far faster than
// a hand does; this releases what it wrote a few characters at a time, with the
// pauses a person makes — a breath at a comma, longer at a full stop, longer
// still before starting something new — so the paper reads as being written,
// not printed.
//
// Pure and clock-free: the caller passes the time in. Every rule here is a
// number in a test.
//
// The spec asks for chunks of 2–6 characters every 60–120ms, and for about
// 15–20 characters a second overall. The two only agree if the wait after a
// chunk includes the time the chunk itself took to write, so it does: the
// hesitation (60–120ms) plus ~40ms a character — about 16 a second.

// Relative, not `@shared`: the test runner has no vite aliases.
import type { Letter, LetterBlock } from '../../../../src/shared/protocol.js';

export type SegmentKind = 'title' | 'heading' | 'name' | 'note' | 'paragraph' | 'check';
/** One run of text the pen writes in one go: a title, a heading, an item's name or its note, a paragraph. */
export type Segment = { key: string; kind: SegmentKind; text: string };

/** Where the pen is, when it may write next, and which chunks it has laid down so far. */
export type Pen = {
  seg: number;
  off: number;
  /** When the next chunk is due (ms, caller's clock). */
  nextAt: number;
  /** When the last chunk went down: the cursor starts to blink a while after. */
  lastAt: number;
  /** Everything there is shows at once, and anything that arrives later too. */
  instant: boolean;
  /** Chunk ends per segment key, so each chunk can fade in on its own. */
  marks: Record<string, number[]>;
};

export const PACE = {
  hesitateMs: [60, 120] as const,
  /** Per full-width character; a Latin letter counts as half of one. */
  perCharMs: 40,
  chunkChars: [2, 6] as const,
  chunkWords: [1, 2] as const,
  commaMs: 180,
  stopMs: 320,
  newLineMs: 450,
  headingMs: 700,
  /** Past this many characters waiting, she writes faster, up to twice as fast. */
  backlogChars: 200,
  backlogRampChars: 300,
  maxSpeed: 2,
  /** The cursor holds still while writing and blinks after a pause this long. */
  idleMs: 400,
};

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;
const COMMA = /[，、；：,;:]/u;
const STOP = /[。！？!?…]/u;
const width = (text: string) => [...text].reduce((sum, c) => sum + (WIDE.test(c) ? 1 : 0.5), 0);

const between = ([lo, hi]: readonly [number, number], random: () => number) => lo + (hi - lo) * random();

/** The letter in the order the pen writes it. */
export function letterSegments(letter: Pick<Letter, 'title' | 'blocks'>): Segment[] {
  return [
    ...(letter.title ? [{ key: 'title', kind: 'title' as const, text: letter.title }] : []),
    ...letter.blocks.flatMap(blockSegments),
  ];
}

export function blockSegments(block: LetterBlock): Segment[] {
  if (block.type === 'item') {
    return [
      { key: `${block.id}:name`, kind: 'name', text: block.name },
      ...(block.note ? [{ key: `${block.id}:note`, kind: 'note' as const, text: block.note }] : []),
    ];
  }
  return [{ key: `${block.id}:text`, kind: block.type, text: block.text }];
}

export function startPen(now: number, segments: Segment[] = [], { atEnd = false, instant = false } = {}): Pen {
  const pen: Pen = { seg: 0, off: 0, nextAt: now, lastAt: now, instant, marks: {} };
  if (!atEnd || !segments.length) return pen;
  // Picking up a letter already partly written: what is there shows at once, the rest is paced.
  const last = segments.length - 1;
  return { ...pen, seg: last, off: segments[last]!.text.length, marks: Object.fromEntries(segments.map(s => [s.key, [s.text.length]])) };
}

/**
 * How much the next chunk takes: a few characters of Chinese, a word or two of
 * English, and never across a punctuation mark — the pause belongs after it.
 */
export function chunkLength(text: string, from: number, random: () => number): number {
  const chars = [...text.slice(from)];
  if (!chars.length) return 0;
  const latin = !WIDE.test(chars[0]!);
  let n = 0;
  if (latin) {
    let words = Math.round(between(PACE.chunkWords, random));
    while (n < chars.length) {
      const c = chars[n++]!;
      if (COMMA.test(c) || STOP.test(c)) break;
      if (c === ' ' && --words <= 0) break;
      if (n < chars.length && WIDE.test(chars[n]!)) break;
    }
  } else {
    const size = Math.round(between(PACE.chunkChars, random));
    while (n < chars.length && n < size) {
      const c = chars[n++]!;
      if (COMMA.test(c) || STOP.test(c)) break;
      if (n < chars.length && !WIDE.test(chars[n]!) && !COMMA.test(chars[n]!) && !STOP.test(chars[n]!)) break;
    }
  }
  // Back to UTF-16 length: offsets index the string, and an emoji is two of those.
  return chars.slice(0, n).join('').length;
}

/** The pause after a chunk, by how it ends. */
function pauseAfter(chunk: string) {
  const last = chunk.trimEnd().at(-1) ?? '';
  return STOP.test(last) ? PACE.stopMs : COMMA.test(last) ? PACE.commaMs : 0;
}

/** Characters still waiting to be written. */
export function backlog(pen: Pen, segments: Segment[]): number {
  return segments.reduce((sum, s, i) => sum + (i < pen.seg ? 0 : i === pen.seg ? Math.max(0, s.text.length - pen.off) : s.text.length), 0);
}

/** How fast she writes now: the base speed, raised when she has fallen far behind. */
export function speedFor(waiting: number, base = 1) {
  const ramp = 1 + Math.min(1, Math.max(0, waiting - PACE.backlogChars) / PACE.backlogRampChars) * (PACE.maxSpeed - 1);
  return Math.max(base, ramp);
}

/**
 * Moves the pen up to `now`. Text that has not arrived yet is waited for in
 * place: the pen does not save up time while it waits, so when words arrive
 * they are written at the usual pace rather than in one burst.
 */
export function advance(pen: Pen, segments: Segment[], now: number, { speed = 1, random = Math.random }: { speed?: number; random?: () => number } = {}): Pen {
  if (pen.instant) {
    const marks = Object.fromEntries(segments.map(s => [s.key, pen.marks[s.key]?.includes(s.text.length) ? pen.marks[s.key]! : [...(pen.marks[s.key] ?? []), s.text.length]]));
    const last = Math.max(0, segments.length - 1);
    return { ...pen, seg: last, off: segments[last]?.text.length ?? 0, marks, nextAt: now };
  }
  const p: Pen = { ...pen, marks: { ...pen.marks } };
  for (let guard = 0; guard < 1000 && now >= p.nextAt; guard++) {
    const seg = segments[p.seg];
    if (!seg) break;
    if (p.off >= seg.text.length) {
      const next = segments[p.seg + 1];
      if (!next) { p.nextAt = now; break; }
      // A new line of the letter: a pause, longer before a new section.
      p.seg++;
      p.off = 0;
      p.nextAt += (next.kind === 'heading' ? PACE.headingMs : next.kind === 'note' ? PACE.commaMs : PACE.newLineMs) / speed;
      continue;
    }
    const n = chunkLength(seg.text, p.off, random);
    const chunk = seg.text.slice(p.off, p.off + n);
    p.off += n;
    p.marks[seg.key] = [...(p.marks[seg.key] ?? []), p.off];
    p.lastAt = p.nextAt;
    const v = speedFor(backlog(p, segments), speed);
    p.nextAt += (between(PACE.hesitateMs, random) + width(chunk) * PACE.perCharMs + pauseAfter(chunk)) / v;
  }
  return p;
}

/** Everything there is has been written. */
export const caughtUp = (pen: Pen, segments: Segment[]) => backlog(pen, segments) === 0;

/**
 * A segment as it shows right now, in the chunks it was written in. Each chunk
 * keeps its start offset, so a new one can be told apart and faded in.
 */
export function shownChunks(pen: Pen, segments: Segment[], index: number): { at: number; text: string }[] {
  const seg = segments[index];
  if (!seg || index > pen.seg) return [];
  const end = index < pen.seg || pen.instant ? seg.text.length : Math.min(pen.off, seg.text.length);
  const cuts = [...new Set([...(pen.marks[seg.key] ?? []).filter(m => m < end), end])].sort((a, b) => a - b);
  let from = 0;
  return cuts.flatMap(to => {
    const piece = seg.text.slice(from, to);
    const chunk = { at: from, text: piece };
    from = to;
    return piece ? [chunk] : [];
  });
}
