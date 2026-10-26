// How the Papers list is laid out: by day, newest first, each paper under the
// day it was written. Pure, so the day boundaries are testable.
//
// Relative, not `@shared`: the test runner has no vite aliases.
import type { Paper, PaperBlock } from '../../../../src/shared/protocol.js';

/** `today`, `yesterday`, or the ISO of that day's local midnight. */
export type Day = 'today' | 'yesterday' | string;

const midnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

/** Papers in their days, in the order they came (newest first), the days in that order too. */
export function byDay<P extends Pick<Paper, 'createdAt'>>(papers: P[], now: Date): { day: Day; papers: P[] }[] {
  const today = midnight(now).getTime();
  const yesterday = new Date(today - 1).setHours(0, 0, 0, 0);
  return papers.reduce<{ day: Day; papers: P[] }[]>((groups, paper) => {
    const start = midnight(new Date(paper.createdAt)).getTime();
    const day = start === today ? 'today' : start === yesterday ? 'yesterday' : new Date(start).toISOString();
    const last = groups.at(-1);
    return last?.day === day
      ? [...groups.slice(0, -1), { day, papers: [...last.papers, paper] }]
      : [...groups, { day, papers: [paper] }];
  }, []);
}

const words = (block: PaperBlock) =>
  block.type === 'item' ? block.name : block.type === 'heading' ? '' : block.text.replace(/\s+/g, ' ').trim();

/**
 * How it begins, in one line: the first paragraph if there is one before any
 * list, otherwise the first few things on it. Headings say what a section is,
 * not what the paper says, so they are passed over.
 */
export function preview(paper: Pick<Paper, 'blocks'>): string {
  const first = paper.blocks.find(b => b.type !== 'heading');
  if (!first) return '';
  if (first.type === 'paragraph') return words(first);
  return paper.blocks.filter(b => b.type === 'item' || b.type === 'check').slice(0, 3).map(words).join(' · ');
}
