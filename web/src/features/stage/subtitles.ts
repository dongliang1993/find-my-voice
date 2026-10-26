// Relative, not `@shared`: the test runner has no vite aliases.
import { endsSentence, splitSentences } from '../../../../src/shared/sentences.js';

/**
 * How wide short sentences may grow by merging, in ems — her line is 22em, so
 * this is two lines, less what wrapping at word breaks loses. Counted in ems rather than characters because a
 * Latin letter takes half of what a Chinese one does. A single sentence is
 * never cut to fit it: the caption steps its size down instead.
 */
export const MAX_EM = 36;
/** Narrower than this is merged forward, so the caption does not flicker word by word. */
const MIN_EM = 10;

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;
/** Display width in ems: full-width scripts take a whole one, everything else about half. */
export const width = (text: string) => [...text].reduce((sum, char) => sum + (WIDE.test(char) ? 1 : 0.5), 0);
/** Splitting trims each piece, which drops the space between two Latin words; give it back. */
const gap = (left: string, right: string) => (WIDE.test(left.at(-1) ?? '') || WIDE.test(right[0] ?? '') ? '' : ' ');
/** Reading pace in ems per second: about a Chinese character and a half, or three Latin ones. */
export const READING_EPS = 5.5;
/** A breath between beats without audio, so it reads as speech and not a ticker. */
const PAUSE_S = 0.3;

/** One beat of the caption: what is shown, and the second from the reply's start it is due. */
export type Beat = { text: string; at: number };

/** A sentence as the server timed it, from the stream it belongs to. */
export type TimedLine = { text: string; startsAt: number };

type Segment = { text: string; start: number; end: number; ended: boolean };

const cut = (text: string) => splitSentences(text, { minChars: MIN_EM, maxChars: MAX_EM, measure: width, wrap: false });

/**
 * The reply as display beats, one whole sentence each — short ones may share
 * a beat, but no sentence is ever split across two. Boundaries come from the
 * server once it has synthesized them, so the caption lands with the voice.
 * Those pieces are sized for speech, not for a screen: one that stops short of
 * the sentence's end (the opening chunk is cut early so the voice starts
 * sooner) is joined back onto what follows it.
 *
 * Without any timing the same beats are paced by reading speed instead.
 */
export function beats(text: string, timed: TimedLine[] | null): Beat[] {
  if (!timed?.length) return paced(cut(text));

  // Where each timed piece sits in the reply, to tell a line break — which ends a list item — from a cut.
  let at = 0;
  const brokenAfter = timed.map(line => {
    const found = text.indexOf(line.text, at);
    if (found < 0) return false;
    at = found + line.text.length;
    return /^[^\S\n]*\n/.test(text.slice(at));
  });
  const segments = timed.reduce<Segment[]>((out, line, i) => {
    const start = line.startsAt;
    const ended = endsSentence(line.text) || brokenAfter[i]!;
    // Nothing follows the last sentence, so it is given its own reading time.
    const end = timed[i + 1]?.startsAt ?? start + width(line.text) / READING_EPS;
    const last = out.at(-1);
    if (last && (!last.ended || width(last.text) < MIN_EM)) {
      return [...out.slice(0, -1), { ...last, text: last.text + gap(last.text, line.text) + line.text, end, ended }];
    }
    return [...out, { text: line.text, start, end, ended }];
  }, []);

  return segments.flatMap(({ text: sentence, start, end }) => {
    const parts = cut(sentence);
    const total = width(sentence) || 1;
    let walked = 0;
    return parts.map(part => {
      const at = start + (walked / total) * (end - start);
      walked += width(part);
      return { text: part, at };
    });
  });
}

function paced(parts: string[]): Beat[] {
  let at = 0;
  return parts.map(text => {
    const beat = { text, at };
    at += width(text) / READING_EPS + PAUSE_S;
    return beat;
  });
}
