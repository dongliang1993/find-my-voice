// What a letter is made of, and the rules that turn what the model wrote into
// something safe to store and render. Pure, so every rule is testable.
//
// The tool schemas are deliberately loose. A strict one fails the whole call
// when a single block is off — and a letter with one odd line should lose that
// line, not the letter. Each block is checked on its own here instead.

import { z } from 'zod';
import type { Letter, LetterBlock, LetterLink, LetterOp, Note } from '../../shared/protocol.js';
import { LINK_KINDS } from '../../shared/links.js';
import { plainText } from '../../shared/plain.js';

const looseBlock = z.object({
  type: z.string().describe('paragraph（一段话）、heading（小标题，比如「电影」「歌」）、item（一个条目）或 check（一条待办）'),
  text: z.string().optional().describe('paragraph、heading 和 check 的文字'),
  done: z.boolean().optional().describe('check：这条待办是否已经做完'),
  name: z.string().optional().describe('item 的名字：片名、书名、「歌手 · 歌名」、地名'),
  note: z.string().optional().describe('item 的一句理由，用你自己的语气，不超过 20 个字'),
  link: z.object({
    kind: z.string().describe('movie、music、book、place 或 web'),
    query: z.string().describe('用来搜索它的词，比如「花样年华 2000」；不要写网址'),
  }).optional().describe('item 可选：能在网上找到的东西才加'),
}).passthrough();

/** The input of `write_letter`, as the model sees it. */
export const writeLetterShape = {
  title: z.string().describe('信的标题，几个字，比如「下雨天」'),
  blocks: z.array(looseBlock).describe('信的内容，从上到下'),
};

/** The input of `edit_letter`. */
export const editLetterShape = {
  letterId: z.string().describe('要改的那封信的 id'),
  ops: z.array(z.object({
    op: z.string().describe('replace（换掉一块）、delete（删掉一块）或 insert（加一块）'),
    blockId: z.string().optional().describe('replace 和 delete：要改的那一块的 id'),
    afterBlockId: z.string().nullable().optional().describe('insert：加在哪一块后面；null 表示加在最前面'),
    block: looseBlock.optional().describe('replace 和 insert：新的那一块'),
  }).passthrough()).describe('要做的改动，按顺序'),
};

/** The input of `write_note`: the same blocks a letter is made of, no id to name. */
export const writeNoteShape = {
  // First, so it streams in before any line: the card knows whether to wipe or append.
  fresh: z.boolean().optional().describe('换了一个新话题时填 true：擦掉桌上那张重写；同一件事接着写就不填'),
  title: z.string().describe('便签的标题，几个字，比如「今天要做的事」'),
  blocks: z.array(looseBlock).describe('便签的内容，从上到下'),
};

/** The input of `update_preferences`: only what the user asked to change. */
export const preferencesShape = {
  language: z.enum(['auto', 'zh', 'en']).optional().describe('回复用的语言：zh 中文、en 英文、auto 跟着对方说的语言'),
  initiative: z.enum(['off', 'occasional', 'often']).optional().describe('主动找对方的频率：off 不主动、occasional 偶尔、often 经常'),
};

/** The input of `edit_note`: there is only ever one note, so no id to name. */
export const editNoteShape = {
  ops: z.array(z.object({
    op: z.string().describe('replace（换掉一块）、delete（删掉一块）或 insert（加一块）'),
    blockId: z.string().optional().describe('replace 和 delete：要改的那一块的 id'),
    afterBlockId: z.string().nullable().optional().describe('insert：加在哪一块后面；null 表示加在最前面'),
    block: looseBlock.optional().describe('replace 和 insert：新的那一块'),
  }).passthrough()).describe('要做的改动，按顺序'),
};

const LIMITS = { title: 30, heading: 40, name: 80, note: 60, paragraph: 1200, query: 80, blocks: 40 };

/** One line, no markup. */
const line = (value: unknown, max: number) =>
  typeof value === 'string' ? plainText(value).replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** A paragraph keeps its line breaks — a poem is its lines — but loses the markup. */
const lines = (value: unknown, max: number) =>
  typeof value === 'string'
    ? plainText(value).split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max)
    : '';

function toLink(raw: unknown, name: string): LetterLink | null {
  if (!raw || typeof raw !== 'object') return null;
  const { kind, query } = raw as { kind?: unknown; query?: unknown };
  if (typeof kind !== 'string' || !LINK_KINDS.includes(kind as LetterLink['kind'])) return null;
  // A link that names nothing to search for still has the item's own name.
  return { kind: kind as LetterLink['kind'], query: line(query, LIMITS.query) || name };
}

/** One block as stored, or null when it is not something the paper can show. */
export function toBlock(raw: unknown, id: string): LetterBlock | null {
  if (!raw || typeof raw !== 'object') return null;
  const block = raw as Record<string, unknown>;
  switch (block.type) {
    case 'paragraph': {
      const text = lines(block.text, LIMITS.paragraph);
      return text ? { id, type: 'paragraph', text } : null;
    }
    case 'heading': {
      const text = line(block.text, LIMITS.heading);
      return text ? { id, type: 'heading', text } : null;
    }
    case 'item': {
      const name = line(block.name, LIMITS.name);
      return name ? { id, type: 'item', name, note: line(block.note, LIMITS.note), link: toLink(block.link, name) } : null;
    }
    case 'check': {
      const text = line(block.text, LIMITS.name);
      return text ? { id, type: 'check', text, done: block.done === true } : null;
    }
    default:
      return null;
  }
}

/**
 * The blocks of a letter as written. Ids follow the position the model wrote
 * them in, so the ids reported back to it match, even when a block in the
 * middle is dropped. Works on a letter still being streamed as well: the last
 * block may be cut short, and one whose type has not arrived yet is skipped.
 */
export function toBlocks(raw: unknown): LetterBlock[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, LIMITS.blocks).flatMap((b, i) => toBlock(b, `b${i + 1}`) ?? []);
}

export const toTitle = (raw: unknown) => line(raw, LIMITS.title);

/** The number one past the highest block id ever used in this letter, so a deleted id is never handed out again. */
export function nextBlockNumber(...versions: LetterBlock[][]): number {
  const numbers = versions.flat().map(b => Number(/^b(\d+)$/.exec(b.id)?.[1] ?? 0));
  return Math.max(0, ...numbers) + 1;
}

/**
 * The note as one plain text, and back again. Shared, so the whole-card
 * editor on the page and the server here read and write the same lines.
 */
export { parseNoteText, noteText } from '../../shared/notes.js';

/**
 * Applies an edit to a letter's blocks. Each op stands on its own: a bad one
 * (an id that does not exist, a block that is not valid) is reported and
 * skipped, and the rest still apply — "change the third song and drop the
 * second film" should not lose the first half to a typo in the second.
 */
export function applyOps(blocks: LetterBlock[], rawOps: unknown, nextNumber: number): { blocks: LetterBlock[]; ops: LetterOp[]; errors: string[] } {
  let current = [...blocks];
  const applied: LetterOp[] = [];
  const errors: string[] = [];
  let next = nextNumber;
  const has = (id: unknown): id is string => typeof id === 'string' && current.some(b => b.id === id);

  for (const [i, raw] of (Array.isArray(rawOps) ? rawOps : []).entries()) {
    const op = (raw ?? {}) as Record<string, unknown>;
    const where = `第 ${i + 1} 处改动`;
    if (op.op === 'delete') {
      if (!has(op.blockId)) { errors.push(`${where}：没有 id 为 ${String(op.blockId)} 的一块`); continue; }
      current = current.filter(b => b.id !== op.blockId);
      applied.push({ op: 'delete', blockId: op.blockId });
    } else if (op.op === 'replace') {
      if (!has(op.blockId)) { errors.push(`${where}：没有 id 为 ${String(op.blockId)} 的一块`); continue; }
      const block = toBlock(op.block, op.blockId);
      if (!block) { errors.push(`${where}：新的那一块不完整`); continue; }
      current = current.map(b => (b.id === block.id ? block : b));
      applied.push({ op: 'replace', blockId: block.id, block });
    } else if (op.op === 'insert') {
      const after = op.afterBlockId ?? null;
      if (after !== null && !has(after)) { errors.push(`${where}：没有 id 为 ${String(after)} 的一块`); continue; }
      const block = toBlock(op.block, `b${next}`);
      if (!block) { errors.push(`${where}：新的那一块不完整`); continue; }
      next++;
      const at = after === null ? 0 : current.findIndex(b => b.id === after) + 1;
      current = [...current.slice(0, at), block, ...current.slice(at)];
      applied.push({ op: 'insert', afterBlockId: after, block });
    } else {
      errors.push(`${where}：不认识的改法 ${String(op.op)}`);
    }
  }
  return { blocks: current, ops: applied, errors };
}

const describeBlock = (b: LetterBlock) =>
  b.type === 'item' ? `${b.id} 条目：${b.name}${b.note ? `——${b.note}` : ''}`
    : b.type === 'heading' ? `${b.id} 小标题：${b.text}`
      : b.type === 'check' ? `${b.id} 待办：${b.text}（${b.done ? '已办' : '未办'}）`
        : `${b.id} 段落：${b.text.replace(/\n/g, ' / ')}`;

/** The letter as she needs to see it to change it: every block with its id. */
export function describeLetter(letter: Pick<Letter, 'id' | 'title' | 'blocks'>): string {
  return [`信「${letter.title}」（id: ${letter.id}）：`, ...letter.blocks.map(describeBlock)].join('\n');
}

/**
 * The line the chat history keeps for a letter, and what her memory reads:
 * the title and the names of what she picked, never the whole text.
 */
export function letterSummary(letter: Pick<Letter, 'title' | 'blocks'>): string {
  const names = letter.blocks.flatMap(b => (b.type === 'item' ? [b.name] : []));
  const first = letter.blocks.find(b => b.type === 'paragraph');
  const body = names.length ? names.join('、') : first?.type === 'paragraph' ? first.text.replace(/\s+/g, ' ').slice(0, 40) : '';
  return `（写了一封信「${letter.title || '无题'}」${body ? `：${body}` : ''}）`;
}

/** The note as she needs to see it to change it: every block with its id. There is only ever one. */
export function describeNote(note: Pick<Note, 'title' | 'blocks'>): string {
  return [`便签「${note.title || '无题'}」：`, ...note.blocks.map(describeBlock)].join('\n');
}
