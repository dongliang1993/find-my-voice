import { useCallback, useEffect, useRef, useState } from 'react';
import type { LetterBlock } from '@shared/protocol';
import type { LetterEdit, NoteEdit } from '@/hooks/useChat';

/**
 * A line of the letter while an edit plays: as it was, being struck out,
 * folding away, or being written fresh.
 */
export type Row = { key: string; block: LetterBlock; phase: 'shown' | 'strike' | 'gone' | 'write' };

const sleep = (ms: number) => new Promise<void>(resolve => { window.setTimeout(resolve, ms); });

/** The timings of the spec, in order: find the line, rest on it, strike it, fold it away. */
export const EDIT_MS = { scroll: 500, rest: 300, strike: 400, fold: 300 };

type Options = {
  letterId: string;
  /** Letters and notes play their edits the same way. */
  edits: (LetterEdit | NoteEdit)[];
  /** The first writing is over: edits play on a finished page, never over the pen. */
  ready: boolean;
  still: boolean;
  /** Brings a line into view, smoothly. */
  scrollTo: (blockId: string) => void;
};

/**
 * Plays her edits on the open paper, one change at a time: the paper scrolls to
 * the line, her cursor rests on it, a red line strikes the old words out, they
 * fold away, and she writes the new ones in their place. Only edits made while
 * this paper is open are played — one made earlier is simply what the letter
 * says now. The strikes leave no trace: when it is over, the paper shows the
 * letter as it now is.
 *
 * `rows` is null whenever nothing is playing: then the letter renders itself.
 */
export function useEditPlayer({ letterId, edits, ready, still, scrollTo }: Options) {
  const played = useRef(Math.max(0, ...edits.filter(e => e.after.id === letterId).map(e => e.seq)));
  const [rows, setRows] = useState<Row[] | null>(null);
  /** The line her cursor rests on while she decides what to do with it. */
  const [resting, setResting] = useState<string | null>(null);
  const busy = useRef(false);
  const alive = useRef(true);
  const written = useRef<(() => void) | null>(null);
  const scroll = useRef(scrollTo);
  scroll.current = scrollTo;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    if (!ready || busy.current) return;
    const queue = edits.filter(e => e.after.id === letterId && e.seq > played.current);
    if (!queue.length) return;
    busy.current = true;
    void (async () => {
      for (const edit of queue) {
        played.current = edit.seq;
        // Without motion there is nothing to watch: the letter just is the new version.
        if (still) continue;
        let current: Row[] = edit.before.blocks.map(block => ({ key: block.id, block, phase: 'shown' }));
        const show = (next: Row[]) => { current = next; if (alive.current) setRows(next); };
        show(current);
        for (const op of edit.ops) {
          if (!alive.current) return;
          const anchor = op.op === 'insert' ? op.afterBlockId : op.blockId;
          if (anchor) { scroll.current(anchor); await sleep(EDIT_MS.scroll); }
          setResting(anchor);
          await sleep(EDIT_MS.rest);
          let at: number;
          if (op.op === 'insert') {
            at = op.afterBlockId === null ? 0 : current.findIndex(r => r.block.id === op.afterBlockId) + 1;
          } else {
            const target = (phase: Row['phase']) => (r: Row) => (r.block.id === op.blockId && r.phase !== 'write' ? { ...r, phase } : r);
            show(current.map(target('strike')));
            await sleep(EDIT_MS.strike);
            show(current.map(target('gone')));
            await sleep(EDIT_MS.fold);
            at = current.findIndex(r => r.block.id === op.blockId && r.phase === 'gone');
            show(current.filter((_, i) => i !== at));
          }
          setResting(null);
          if (op.op !== 'delete') {
            show([...current.slice(0, at), { key: `${op.block.id}@${edit.seq}`, block: op.block, phase: 'write' }, ...current.slice(at)]);
            await new Promise<void>(resolve => { written.current = resolve; });
            show(current.map(r => (r.phase === 'write' ? { ...r, phase: 'shown' } : r)));
          }
        }
      }
      busy.current = false;
      if (alive.current) { setRows(null); setResting(null); }
    })();
  }, [edits, ready, still, letterId, rows]);

  /** A line being written fresh has caught up with itself. */
  const onWritten = useCallback(() => { written.current?.(); written.current = null; }, []);

  return { rows, resting, onWritten };
}
