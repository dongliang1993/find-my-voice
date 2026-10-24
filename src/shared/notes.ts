// The note as one plain text, and back again. The whole-card editor on the
// page holds the card as text a hand can type freehand; the server reads that
// text back into the same blocks she writes. Shared so both sides read and
// write the same lines.

import type { LetterBlock } from './protocol.js';
import { plainMarkedText } from './plain.js';

const LIMITS = { title: 30, heading: 40, name: 80, note: 60, paragraph: 1200, blocks: 40 };

/**
 * The note as one plain text, the way a hand writes it on a card: `##` a
 * heading, `-` an item, `- [ ]` / `- [x]` a to-do, a blank line a breath
 * between paragraphs, and anything else a paragraph of its own. What the
 * whole-card editor sends back is read here, so a card typed freehand and a
 * card she wrote meet in the same blocks.
 */
export function parseNoteText(raw: unknown): LetterBlock[] {
  const text = typeof raw === 'string' ? plainMarkedText(raw).slice(0, 8000) : '';
  const out: LetterBlock[] = [];
  /** Paragraph lines waiting for a blank line to close them. */
  let para: string[] = [];
  const flush = () => {
    const body = para.join('\n').trim();
    para = [];
    if (body) out.push({ id: '', type: 'paragraph', text: body.slice(0, LIMITS.paragraph) });
  };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/[ \t]+/g, ' ').trim();
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    const check = /^[-*+]\s+\[( |x|X)\]\s+(.+)$/.exec(line);
    const item = /^[-*+•]\s+(.+)$/.exec(line);
    if (!line) { flush(); continue; }
    if (heading) {
      flush();
      out.push({ id: '', type: 'heading', text: heading[1]!.slice(0, LIMITS.heading) });
    } else if (check) {
      flush();
      out.push({ id: '', type: 'check', text: check[2]!.slice(0, LIMITS.name), done: check[1] !== ' ' });
    } else if (item) {
      flush();
      // An item line may carry its one-line reason after a dash: `- 伞 —— 楼下那把黑的`.
      const [name, ...reason] = item[1]!.split(/\s+——\s+/);
      out.push({ id: '', type: 'item', name: (name ?? '').slice(0, LIMITS.name), note: reason.join('—— ').slice(0, LIMITS.note), link: null });
    } else {
      para.push(line);
    }
    if (out.length >= LIMITS.blocks) break;
  }
  flush();
  return out.slice(0, LIMITS.blocks);
}

/** The note as one plain text again, the inverse of `parseNoteText`: what the whole-card editor opens with. */
export function noteText(blocks: LetterBlock[]): string {
  return blocks.map(b => {
    if (b.type === 'heading') return `## ${b.text}`;
    if (b.type === 'check') return `- [${b.done ? 'x' : ' '}] ${b.text}`;
    if (b.type === 'item') return `- ${b.name}${b.note ? ` —— ${b.note}` : ''}`;
    return b.text;
  }).join('\n\n');
}
