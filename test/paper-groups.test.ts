import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byDay, preview } from '../web/src/features/paper/groups.js';
import type { Paper } from '../src/shared/protocol.js';

const at = (id: string, local: [number, number, number, number]) => ({
  id, createdAt: new Date(2026, local[0], local[1], local[2], local[3]).toISOString(),
});

test('papers fall under today, yesterday, then their own date, newest first within each', () => {
  const now = new Date(2026, 9, 26, 18, 0);
  const groups = byDay([at('a', [9, 26, 16, 12]), at('b', [9, 26, 9, 0]), at('c', [9, 25, 23, 59]), at('d', [9, 24, 8, 0])], now);
  assert.deepEqual(groups.map(g => [g.day, g.papers.map(p => p.id)]), [
    ['today', ['a', 'b']], ['yesterday', ['c']], [new Date(2026, 9, 24).toISOString(), ['d']],
  ]);
});

test('just after midnight, last evening is yesterday', () => {
  const groups = byDay([at('a', [9, 25, 23, 30])], new Date(2026, 9, 26, 0, 5));
  assert.equal(groups[0]?.day, 'yesterday');
});

test('the preview is how it begins: the first line of words, whatever kind', () => {
  const blocks = (b: unknown[]) => ({ blocks: b }) as Pick<Paper, 'blocks'>;
  assert.equal(preview(blocks([{ id: 'b1', type: 'heading', text: '电影' }, { id: 'b2', type: 'paragraph', text: 'Something to watch\nwhen your head' }])), 'Something to watch when your head');
  assert.equal(preview(blocks([{ id: 'b1', type: 'item', name: '花样年华', note: '雨', link: null }, { id: 'b2', type: 'check', text: '带伞', done: false }])), '花样年华 · 带伞');
  assert.equal(preview(blocks([])), '');
});
