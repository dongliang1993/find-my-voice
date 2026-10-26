import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { Paper, PaperBlock } from '@shared/protocol';
import { linkUrl } from '@shared/links';
import { paperText, parsePaperText } from '@shared/paper-text';
import { blockSegments, caughtUp, paperSegments, shownChunks, type Segment } from '@/features/paper/pace';
import { useEditPlayer, type Row } from '@/features/paper/useEditPlayer';
import { usePen } from '@/features/paper/usePen';
import type { PaperEdit } from '@/hooks/useChat';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { dayOf, timeOf, useSay, useUi } from '@/lib/locale';

type Source = (segment: Segment) => { at: number; text: string }[] | null;
type Cursor = { key: string; stamp: number } | null;

function Ink({ segment, source, cursor }: { segment: Segment; source: Source; cursor: Cursor }) {
  const chunks = source(segment);
  return (
    <>
      {chunks === null ? segment.text : chunks.map(c => <span key={c.at} className="ink-in">{c.text}</span>)}
      {cursor?.key === segment.key && (
        <span key={cursor.stamp} aria-hidden="true" className="pen-cursor ml-px inline-block h-[1em] w-[1.5px] translate-y-[0.16em] bg-(--paper-seal)" />
      )}
    </>
  );
}

/** One block, in her pen or as it now stands. Without `onTick` a box is only drawn. */
function Block({ block, source, cursor, paperId, onTick, signed = false }: {
  block: PaperBlock; source: Source; cursor: Cursor; paperId: string; onTick?: (blockId: string, done: boolean) => void;
  /** Her name as the last line: set as a signature, not as one more line. */
  signed?: boolean;
}) {
  const [first, second] = blockSegments(block);
  if (!first) return null;
  if (block.type === 'heading') {
    return <h3 className="mt-7 mb-1 font-heading text-[14px] text-(--paper-quiet) italic first:mt-0"><Ink segment={first} source={source} cursor={cursor} /></h3>;
  }
  if (block.type === 'paragraph' && signed) {
    return <p className="mt-8 text-right font-heading text-[17px] italic">—&nbsp;<Ink segment={first} source={source} cursor={cursor} /></p>;
  }
  if (block.type === 'paragraph') {
    return <p className="my-3 font-heading text-[16px] leading-[1.75] whitespace-pre-line"><Ink segment={first} source={source} cursor={cursor} /></p>;
  }
  if (block.type === 'check') {
    return (
      <p className="my-2.5 flex items-start gap-2.5 font-heading text-[17px] leading-[1.6]">
        {/* The box, on the first line's middle however many lines follow. Clicking it is the user's own hand. */}
        <span className="flex h-[1.6em] flex-none items-center">
          <button type="button"
            disabled={!onTick}
            onClick={event => { event.stopPropagation(); onTick?.(block.id, !block.done); }}
            aria-pressed={block.done} aria-label={block.done ? `已办：${block.text}` : `待办：${block.text}`}
            className="paper-box focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--paper-seal)/60" data-done={block.done} />
        </span>
        {/* Crossed off by her red line, drawn left to right. */}
        <span className="min-w-0">
          <span className="ink-struck" data-done={block.done}>
            {block.done ? block.text : <Ink segment={first} source={source} cursor={cursor} />}
          </span>
        </span>
      </p>
    );
  }
  return <ItemLine block={block} first={first} second={second} source={source} cursor={cursor} paperId={paperId} />;
}

/** An item; one that names something to find opens its search. */
function ItemLine({ block, first, second, source, cursor, paperId }: {
  block: Extract<PaperBlock, { type: 'item' }>; first: Segment; second: Segment | undefined; source: Source; cursor: Cursor; paperId: string;
}) {
  const say = useSay();
  const open = (event: React.MouseEvent) => {
    // Not a click into the paper: that would bring up the whole-paper editor.
    event.stopPropagation();
    if (!block.link) return;
    const url = linkUrl(block.link);
    // The server opens it in the system browser; where it cannot, this page does.
    api.openLink(paperId, block.id).catch(() => window.open(url, '_blank', 'noopener'));
  };
  return (
    <p className="my-4 font-heading text-[17px] leading-[1.45] @md:my-2.5">
      {block.link ? (
        <button type="button" onClick={open} title={say(`去找「${block.name}」`, `Look for “${block.name}”`)}
          className="cursor-pointer text-left decoration-transparent decoration-[0.5px] underline underline-offset-4 transition-[text-decoration-color] duration-200 hover:decoration-(--paper-quiet)/60 focus-visible:outline-none focus-visible:decoration-(--paper-quiet)/60">
          <Ink segment={first} source={source} cursor={cursor} />
        </button>
      ) : <Ink segment={first} source={source} cursor={cursor} />}
      {/* Narrow, its reason goes under it rather than wrapping in pieces beside it. */}
      {second && <span className="mt-1 block text-[14px] leading-snug text-(--paper-quiet) @md:mt-0 @md:ml-2.5 @md:inline @md:leading-[inherit]"><Ink segment={second} source={source} cursor={cursor} /></span>}
    </p>
  );
}

/** How long the paper waits after the last keystroke before it saves itself. */
const SAVE_DEBOUNCE_MS = 800;

/** One line of the surface, no markup: what the paper reads back. */
const lineText = (div: HTMLElement) => div.innerText.replace(/ /g, ' ');

/** The box of a check line: ticked by a click, never typed through. */
function boxSpan() {
  const span = document.createElement('span');
  span.contentEditable = 'false';
  span.className = 'box';
  span.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.5 4.8 9 10 3.2" /></svg>';
  return span;
}

/** One block of the surface: the same look as the line that shows it. */
function blockDiv(block: PaperBlock): HTMLElement {
  const div = document.createElement('div');
  div.dataset.type = block.type;
  if (block.type === 'check') {
    div.dataset.done = String(block.done);
    div.append(boxSpan(), document.createTextNode(block.text));
  } else if (block.type === 'item') {
    div.textContent = block.name;
    if (block.note) {
      const why = document.createElement('span');
      why.className = 'why';
      why.textContent = block.note;
      div.append(why);
    }
  } else {
    div.textContent = block.text;
  }
  return div;
}

/** The paper laid out as lines: what the surface opens with, and what it goes back to. */
function renderCard(root: HTMLElement, blocks: PaperBlock[]) {
  root.replaceChildren(...blocks.map(blockDiv));
}

/** The paper as the surface holds it: the same markdown the server reads back. */
function surfaceMarkdown(root: HTMLElement): string {
  const lines: string[] = [];
  for (const el of Array.from(root.children)) {
    const div = el as HTMLElement;
    const text = lineText(div).trim();
    if (!text) continue;
    switch (div.dataset.type) {
      case 'heading':
        lines.push(`## ${text}`);
        break;
      case 'check':
        lines.push(`- [${div.dataset.done === 'true' ? 'x' : ' '}] ${text}`);
        break;
      case 'item': {
        // Its reason sits to the side; together they are the one line the server reads.
        const why = div.querySelector<HTMLElement>('.why');
        const name = why?.previousSibling?.textContent?.replace(/ /g, ' ').trim() ?? '';
        const reason = why?.textContent?.trim() ?? '';
        lines.push(why ? `- ${name || text}${reason ? ` —— ${reason}` : ''}` : `- ${text}`);
        break;
      }
      default:
        lines.push(text);
    }
  }
  return lines.join('\n\n');
}

/**
 * The whole paper in the user's own hand: the same lines, the same look —
 * heading, item, box and all — editable in place. No modes, no markers
 * shown: typing `## `, `- ` or `- [ ] ` at the start of a line is what
 * turns it into that, and whatever it says when the hand stops (or
 * leaves) is the paper.
 */
function Surface({ paper, at, onRest }: { paper: Paper; at: { x: number; y: number } | null; onRest: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  /** The text it opened with: what goes back on Escape, and what it saves against. */
  const opened = useRef('');
  const timer = useRef<number | undefined>(undefined);
  /** Typed since the last save: while it is set, a change from elsewhere can wait. */
  const dirty = useRef(false);
  /** The version our own save came back as, so her change is told from our echo. */
  const savedVersion = useRef<number | null>(null);

  // It opens under the hand: the click that called it up is where the caret lands.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    renderCard(root, paper.blocks);
    opened.current = paperText(paper.blocks);
    const range = at ? document.caretRangeFromPoint(at.x, at.y) : null;
    if (range && root.contains(range.startContainer)) {
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    } else {
      root.focus();
    }
  }, []);

  // She or another page changed it while this surface sat open: take theirs —
  // unless the hand is mid-writing, or it is only our own save coming back.
  useEffect(() => {
    const root = ref.current;
    if (!root || dirty.current || paper.version === savedVersion.current) return;
    const theirs = paperText(paper.blocks);
    if (theirs === surfaceMarkdown(root)) return;
    renderCard(root, paper.blocks);
    opened.current = theirs;
  }, [paper.version]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const save = () => {
    window.clearTimeout(timer.current);
    const root = ref.current;
    if (!root) return;
    const next = surfaceMarkdown(root);
    if (next.trim() && next !== opened.current) {
      void api.rewriteText(paper.id, next)
        .then(revised => { opened.current = next; savedVersion.current = revised.version; dirty.current = false; })
        .catch(() => { /* the paper keeps what it says; the next stop tries again */ });
    } else {
      dirty.current = false;
    }
  };
  const queue = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(save, SAVE_DEBOUNCE_MS);
  };

  /** The line the caret is on. */
  const caretLine = () => {
    const node = document.getSelection()?.anchorNode;
    const el = node ? (node.nodeType === Node.TEXT_NODE ? node.parentElement : node as HTMLElement) : null;
    return (el?.closest('[data-type]') ?? null) as HTMLElement | null;
  };

  /** What a line starts with is what it is: `## ` a heading, `- ` an item, `- [ ]` a to-do. */
  const autoformat = (div: HTMLElement) => {
    const text = lineText(div).trim();
    const heading = /^#{1,6}\s+(.+)$/.exec(text);
    const check = /^[-*+•]\s*\[( |x|X)\]\s*(.+)$/.exec(text);
    const item = /^[-*+•]\s+(.+)$/.exec(text);
    if (!heading && !check && !item) return;
    const type = heading ? 'heading' : check ? 'check' : 'item';
    div.dataset.type = type;
    if (type === 'check') div.dataset.done = String(check![1] !== ' ');
    else delete div.dataset.done;
    const words = type === 'check' ? check![2]! : (heading ?? item)![1]!;
    div.replaceChildren(...(type === 'check' ? [boxSpan(), document.createTextNode(words)] : [document.createTextNode(words)]));
    // The words stayed; only the look changed. The caret goes to the end of them.
    const range = document.createRange();
    range.selectNodeContents(div);
    range.collapse(false);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };

  // Blur is the hand leaving: save what it said, then rest back into her lines.
  const rest = () => { save(); onRest(); };

  return (
    <div ref={ref} contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label={paper.title || 'Papers'}
      spellCheck={false} className="paper-surface min-h-full outline-none"
      onBlur={rest}
      onInput={() => { dirty.current = true; const line = caretLine(); if (line) autoformat(line); queue(); }}
      onClick={event => {
        // A click in a box ticks it, the same as when reading — not a place to type.
        const box = (event.target as HTMLElement).closest('.box');
        const line = box?.closest('[data-type="check"]');
        if (!box || !line) return;
        event.preventDefault();
        (line as HTMLElement).dataset.done = String((line as HTMLElement).dataset.done !== 'true');
        dirty.current = true;
        queue();
      }}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          if (ref.current) { renderCard(ref.current, parsePaperText(opened.current)); ref.current.blur(); }
          return;
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          // A new line is a new block, not a break inside one.
          event.preventDefault();
          const line = caretLine();
          const root = ref.current;
          if (!line || !root) return;
          const next = document.createElement('div');
          const selection = document.getSelection();
          if (selection?.rangeCount) {
            // What the caret leaves behind goes with it.
            const trailing = selection.getRangeAt(0).cloneRange();
            trailing.setEnd(line, line.childNodes.length);
            next.append(trailing.extractContents());
          }
          if (!next.firstChild) next.append(document.createElement('br'));
          line.after(next);
          const range = document.createRange();
          range.selectNodeContents(next);
          range.collapse(true);
          selection?.removeAllRanges();
          selection?.addRange(range);
          dirty.current = true;
          queue();
        }
      }}>
    </div>
  );
}


/** A line she is writing fresh during an edit: its own pen, at the writing pace. */
function Rewrite({ block, paperId, still, onWritten, onTick }: { block: PaperBlock; paperId: string; still: boolean; onWritten: () => void; onTick?: (blockId: string, done: boolean) => void }) {
  const segments = useMemo(() => blockSegments(block), [block]);
  const { pen } = usePen(segments, 'live', still);
  const done = caughtUp(pen, segments);
  useEffect(() => { if (done) onWritten(); }, [done, onWritten]);
  const source: Source = s => shownChunks(pen, segments, segments.findIndex(x => x.key === s.key));
  const at = segments[Math.min(pen.seg, segments.length - 1)];
  return <Block block={block} source={source} cursor={done || !at ? null : { key: at.key, stamp: pen.lastAt }} paperId={paperId} onTick={onTick} />;
}

/**
 * What a paper says, under her pen or the user's hand — the same on the stage
 * and in Papers. While she writes it follows her pen down; a click skips to
 * what she has written so far. Once it rests, a click turns the whole of it
 * into one text surface under the hand. Changes she makes while it is open
 * are shown being made. Keyed by the paper from outside: a new one starts its own pen.
 *
 * `page`: laid out as a sheet in Papers — a title that carries it, when it
 * was written under that, and a column kept to a reading width.
 */
export function PaperBody({ paper, edits, still, page = false, signer, onWriting }: {
  paper: Paper; edits: PaperEdit[]; still: boolean; page?: boolean;
  /** Her name: a last paragraph that is only her name is her signature. */
  signer?: string;
  /** Told whether her pen (or an edit) is still moving, for the shell around it. */
  onWriting?: (writing: boolean) => void;
}) {
  const segments = useMemo(() => paperSegments(paper), [paper]);
  const { pen, skip } = usePen(segments, paper.status === 'writing' ? 'live' : 'instant', still);
  const writing = paper.status === 'writing' || !caughtUp(pen, segments);
  const scroller = useRef<HTMLDivElement>(null);
  /** Follows the pen down while she writes, until the reader scrolls up. */
  const follow = useRef(true);
  /** Clicked into: the whole paper is one text surface until the hand leaves it. */
  const [hand, setHand] = useState(false);
  /** Where the click that called it up landed, for the caret. */
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  const scrollTo = (blockId: string) => {
    const box = scroller.current;
    const line = box?.querySelector<HTMLElement>(`[data-block="${blockId}"]`);
    if (box && line) box.scrollTo({ top: Math.max(0, line.offsetTop - box.clientHeight / 3), behavior: still ? 'auto' : 'smooth' });
  };
  const { rows, resting, onWritten } = useEditPlayer({ paperId: paper.id, edits, ready: !writing, still, scrollTo });

  // Follow the pen down; let a scroll up read instead.
  useEffect(() => {
    const box = scroller.current;
    if (box && writing && follow.current) box.scrollTop = box.scrollHeight;
  });
  useEffect(() => { onWriting?.(writing || Boolean(rows)); }, [writing, rows]);

  const source: Source = s => shownChunks(pen, segments, segments.findIndex(x => x.key === s.key));
  const current = segments[Math.min(pen.seg, segments.length - 1)];
  const cursor: Cursor = writing && current ? { key: current.key, stamp: pen.lastAt } : null;
  const whole: Source = () => null;
  const reached = (block: PaperBlock) => pen.instant || segments.findIndex(s => s.key === blockSegments(block)[0]?.key) <= pen.seg;
  const body: Row[] = rows ?? paper.blocks.filter(reached).map(block => ({ key: block.id, block, phase: 'shown' }));
  /** Still under a pen — hers or the edit player's — or under the user's own hand. */
  const settled = !writing && !rows;
  const title = segments[0]?.key === 'title' ? segments[0] : null;
  const last = paper.blocks.at(-1);
  const signedId = signer && last?.type === 'paragraph' && last.text.replace(/^[\s—–-]+/, '').trim() === signer.trim() ? last.id : null;

  /** A tick in a check box: saved at once, every page told. */
  const tick = (blockId: string, done: boolean) => {
    void api.patchBlock(paper.id, blockId, { done }).catch(() => {});
  };

  const ui = useUi();
  const head = page ? (
    <header className="mb-6">
      <h2 className="font-heading text-[38px] leading-[1.15] font-normal tracking-[-0.01em] text-balance">
        {title && <Ink segment={title} source={source} cursor={cursor} />}
      </h2>
      <p className="mt-2 text-[12px] text-(--paper-quiet) tabular-nums">{dayOf(paper.createdAt, ui)} · {timeOf(paper.createdAt, ui)}</p>
    </header>
  ) : (
    <header className="flex-none px-11 pt-11">
      <h2 className="font-heading text-[27px] leading-[1.2] font-normal text-balance italic">
        {title && <Ink segment={title} source={source} cursor={cursor} />}
      </h2>
      <p className="mt-1.5 text-[12px] text-(--paper-quiet) tabular-nums">{dayOf(paper.createdAt, ui)} · {timeOf(paper.createdAt, ui)}</p>
    </header>
  );

  return (
    <>
      {!page && head}
      <div ref={scroller} onScroll={() => {
        const box = scroller.current;
        if (box) follow.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
      }} onClick={writing ? skip : settled ? event => {
        // The title is not part of the text a hand rewrites.
        if ((event.target as HTMLElement).closest('header')) return;
        // Where the click landed is where the caret goes, once the surface is up.
        setAt({ x: event.clientX, y: event.clientY });
        setHand(true);
      } : undefined}
        // At rest it is writable, and the pointer says so before the click does.
        className={cn('@container relative min-h-0 flex-1 overflow-y-auto overscroll-contain', settled && !hand && 'cursor-text',
          page ? 'px-10 pt-10 pb-16' : 'px-11 pt-4 pb-11')}>
        <div className={cn(page && 'mx-auto max-w-[620px]')}>
        {page && head}
        {/* The paper in the user's own hand: the same lines, editable in place. */}
        {settled && hand ? <Surface paper={paper} at={at} onRest={() => setHand(false)} /> : <>
        {body.map(({ key, block, phase }) => (
          <AnimatePresence key={key} initial={false}>
            {phase !== 'gone' && (
              <motion.div data-block={block.id}
                initial={phase === 'write' && !still ? { height: 0, opacity: 0 } : false}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0, transition: { duration: still ? 0 : 0.3 } }}
                transition={{ duration: still ? 0 : 0.3 }}
                className="relative">
                {phase === 'write'
                  ? <Rewrite block={block} paperId={paper.id} still={still} onWritten={onWritten} onTick={tick} />
                  : settled
                    ? <Block block={block} source={whole} paperId={paper.id} onTick={tick} cursor={null} signed={block.id === signedId} />
                    : <Block block={block} source={rows ? whole : source} paperId={paper.id} signed={block.id === signedId}
                      onTick={tick}
                      cursor={rows ? (resting === block.id ? { key: blockSegments(block).at(-1)!.key, stamp: 0 } : null) : cursor} />}
                {phase === 'strike' && (
                  <span aria-hidden="true" className="ink-strike pointer-events-none absolute top-[calc(0.25rem+0.85em)] right-0 left-0 h-px bg-(--paper-seal)" />
                )}
              </motion.div>
            )}
          </AnimatePresence>
        ))}
        </>}
        </div>
      </div>
    </>
  );
}
