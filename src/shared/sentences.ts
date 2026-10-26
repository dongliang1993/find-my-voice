// Splits assistant speech into TTS-sized chunks. Shorter chunks start playing
// sooner; too short and each one sounds clipped and costs a request.

// A line break ends a sentence too: a list with its markers stripped is one
// item per line, often with no punctuation, and should still read item by item.
const END = /[。！？!?；;…~～]+|\.(?=\s|$)|\n+/u;
/** A piece that finishes a sentence: its end mark, then any closing quotes or brackets. */
const ENDED = /(?:[。！？!?；;…~～]|\.)["'”’」』）)】]*$/u;
export const endsSentence = (text: string) => ENDED.test(text.trim());
const CLOSERS = /^["'”’」』）)】]+/u;
const SOFT_BREAK = /[，,、：:\s]/u;

/**
 * `firstMaxChars` caps only the opening chunk, at a soft break: it is the one
 * the listener waits on, so it should be quick to synthesize.
 *
 * `measure` scores a piece against those limits, in characters by default. A
 * caller laying text out on a screen passes something closer to its width: a
 * Latin letter takes about half the room of a Chinese one, so a flat character
 * count cuts English into fragments too short to read.
 */
type Options = { minChars?: number; maxChars?: number; firstMaxChars?: number; measure?: (text: string) => number; wrap?: boolean };
const length = (text: string) => [...text].length;

/**
 * Pieces are trimmed, which drops the space between two Latin words. Put it
 * back where one belongs; Chinese takes none, and an inserted one would space
 * it oddly.
 */
const CJK = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;
const gap = (left: string, right: string) => (CJK.test(left.at(-1) ?? '') || CJK.test(right[0] ?? '') ? '' : ' ');

function rawSentences(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest) {
    const match = END.exec(rest);
    if (!match) { out.push(rest); break; }
    let end = match.index + match[0].length;
    const closer = CLOSERS.exec(rest.slice(end));
    if (closer) end += closer[0].length;
    out.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  return out;
}

function hardWrap(sentence: string, maxChars: number, measure: (text: string) => number): string[] {
  const out: string[] = [];
  let rest = sentence;
  while (measure(rest) > maxChars) {
    // Never past the limit, but as near to it as the text allows.
    const chars = [...rest];
    let cut = 0;
    let width = 0;
    while (cut < chars.length && width + measure(chars[cut]!) <= maxChars) width += measure(chars[cut++]!);
    if (cut === 0) cut = 1;
    for (let i = cut - 1; i > cut / 2; i--) if (SOFT_BREAK.test(chars[i]!)) { cut = i + 1; break; }
    out.push(chars.slice(0, cut).join(''));
    rest = chars.slice(cut).join('');
  }
  if (rest) out.push(rest);
  return out;
}

/** Splits the opening chunk at its last soft break within `limit`; with no break to split at, it stays whole. */
function shortenFirst(pieces: string[], limit: number, measure: (text: string) => number): string[] {
  const [first, ...rest] = pieces;
  if (first === undefined || measure(first) <= limit) return pieces;
  const chars = [...first];
  for (let i = chars.length - 1; i > 0; i--) {
    if (!SOFT_BREAK.test(chars[i]!)) continue;
    const head = chars.slice(0, i + 1).join('').trim();
    if (measure(head) > limit) continue;
    const tail = chars.slice(i + 1).join('').trim();
    return tail ? [head, gap(head, tail) + tail, ...rest] : pieces;
  }
  return pieces;
}

/**
 * `wrap: false` never cuts inside a sentence; `maxChars` then only caps how
 * far short sentences are merged. Subtitles want that: half a sentence on
 * screen with the rest of it already gone reads as two thoughts.
 */
export function splitSentences(text: string, { minChars = 1, maxChars = 120, firstMaxChars, measure = length, wrap = true }: Options = {}): string[] {
  const pieces = rawSentences(text).map(s => s.trim()).filter(Boolean).flatMap(s => (wrap ? hardWrap(s, maxChars, measure) : [s]));
  const merged = pieces.reduce<string[]>((merged, piece) => {
    const last = merged.at(-1);
    if (last !== undefined && measure(last) < minChars && measure(last) + measure(piece) <= maxChars) {
      return [...merged.slice(0, -1), last + gap(last, piece) + piece];
    }
    return [...merged, piece];
  }, []);
  return firstMaxChars ? shortenFirst(merged, firstMaxChars, measure) : merged;
}
