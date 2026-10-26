import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion, type TargetAndTransition } from 'motion/react';
import { Inbox, X } from 'lucide-react';
import type { LetterBlock, Note } from '@shared/protocol';
import { noteText, parseNoteText } from '@shared/notes';
import { blockSegments, caughtUp, letterSegments, shownChunks, type Segment } from '@/features/letter/pace';
import { useEditPlayer, type Row } from '@/features/letter/useEditPlayer';
import { usePen } from '@/features/letter/usePen';
import type { NoteEdit } from '@/hooks/useChat';
import { api } from '@/lib/api';
import type { NotePlace } from '@/features/note/place';
import { cn } from '@/lib/utils';
import { dayOf, useUi, WORDS } from '@/lib/locale';

type Props = {
  note: Note;
  edits: NoteEdit[];
  /** Where it sits by the stage. */
  place: NotePlace;
  /** Her name, as she signs a note that is kept. */
  name: string;
  /** Kept: she signs it, then `onSigned`, and it is on its way to the inbox. */
  signing: boolean;
  onSigned: () => void;
  /** Esc or the close button: down to a paper corner at the stage's edge. */
  onFold: () => void;
  /** 收进信箱. */
  onFile: () => void;
};

/** How the card leaves: folded down to its corner, or kept — folded small and flown to the inbox. */
export type NoteExit = { mode: 'fold' | 'file'; inbox: { x: number; y: number } };

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

/** One block of the note, written the same way a letter's are. */
function Block({ block, source, cursor, onTick }: { block: LetterBlock; source: Source; cursor: Cursor; onTick?: (blockId: string, done: boolean) => void }) {
  const [first, second] = blockSegments(block);
  if (!first) return null;
  if (block.type === 'heading') {
    return <h3 className="mt-4 mb-0.5 font-heading text-[13px] text-(--paper-quiet) italic"><Ink segment={first} source={source} cursor={cursor} /></h3>;
  }
  if (block.type === 'paragraph') {
    return <p className="my-1.5 font-heading text-[15px] leading-[1.7] whitespace-pre-line"><Ink segment={first} source={source} cursor={cursor} /></p>;
  }
  if (block.type === 'check') {
    return (
      <p className="my-1 flex items-start gap-2.5 font-heading text-[15px] leading-[1.7]">
        {/* The box, on the first line's middle however many lines follow. Clicking it is the user's own hand. */}
        <span className="flex h-[1.7em] flex-none items-center">
          <button type="button"
            onClick={event => { event.stopPropagation(); onTick?.(block.id, !block.done); }}
            aria-pressed={block.done} aria-label={block.done ? `已办：${block.text}` : `待办：${block.text}`}
            className="note-box focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--paper-seal)/60" data-done={block.done} />
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
  return (
    <p className="my-1 font-heading text-[15px] leading-[1.7]">
      <Ink segment={first} source={source} cursor={cursor} />
      {second && <span className="ml-2 text-[13px] text-(--paper-quiet)"><Ink segment={second} source={source} cursor={cursor} /></span>}
    </p>
  );
}

/** How long the card waits after the last keystroke before it saves itself. */
const SAVE_DEBOUNCE_MS = 800;

/** One line of the surface, no markup: what the card reads back. */
const lineText = (div: HTMLElement) => div.innerText.replace(/ /g, ' ');

/** The box of a check line: ticked by a click, never typed through. */
function boxSpan() {
  const span = document.createElement('span');
  span.contentEditable = 'false';
  span.className = 'box';
  span.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.5 4.8 9 10 3.2" /></svg>';
  return span;
}

/** One block of the surface: the same look as the line on the card that shows it. */
function blockDiv(block: LetterBlock): HTMLElement {
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

/** The card laid out as lines: what the surface opens with, and what it goes back to. */
function renderCard(root: HTMLElement, blocks: LetterBlock[]) {
  root.replaceChildren(...blocks.map(blockDiv));
}

/** The card as the surface holds it: the same markdown the server reads back. */
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
 * The whole card in the user's own hand: the same lines, the same look —
 * heading, item, box and all — editable in place. No modes, no markers
 * shown: typing `## `, `- ` or `- [ ] ` at the start of a line is what
 * turns it into that, and whatever it says when the hand stops (or
 * leaves) is the note.
 */
function NoteSurface({ note, at, onRest }: { note: Note; at: { x: number; y: number } | null; onRest: () => void }) {
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
    renderCard(root, note.blocks);
    opened.current = noteText(note.blocks);
    const range = at ? document.caretRangeFromPoint(at.x, at.y) : null;
    if (range && root.contains(range.startContainer)) {
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    } else {
      root.focus();
    }
  }, []);

  // She or another page changed it while this card sat open: take theirs —
  // unless the hand is mid-writing, or it is only our own save coming back.
  useEffect(() => {
    const root = ref.current;
    if (!root || dirty.current || note.version === savedVersion.current) return;
    const theirs = noteText(note.blocks);
    if (theirs === surfaceMarkdown(root)) return;
    renderCard(root, note.blocks);
    opened.current = theirs;
  }, [note.version]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const save = () => {
    window.clearTimeout(timer.current);
    const root = ref.current;
    if (!root) return;
    const next = surfaceMarkdown(root);
    if (next.trim() && next !== opened.current) {
      void api.rewriteNoteText(next)
        .then(revised => { opened.current = next; savedVersion.current = revised.version; dirty.current = false; })
        .catch(() => { /* the card keeps what it says; the next stop tries again */ });
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
    <div ref={ref} contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="便签"
      spellCheck={false} className="note-surface min-h-full outline-none"
      onBlur={rest}
      onInput={() => { dirty.current = true; const line = caretLine(); if (line) autoformat(line); queue(); }}
      onClick={event => {
        // A click in a box ticks it, the same as on the card — not a place to type.
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
          if (ref.current) { renderCard(ref.current, parseNoteText(opened.current)); ref.current.blur(); }
          return;
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          // A new line is a new block of the card, not a break inside one.
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
function Rewrite({ block, still, onWritten, onTick }: { block: LetterBlock; still: boolean; onWritten: () => void; onTick?: (blockId: string, done: boolean) => void }) {
  const segments = useMemo(() => blockSegments(block), [block]);
  const { pen } = usePen(segments, 'live', still);
  const done = caughtUp(pen, segments);
  useEffect(() => { if (done) onWritten(); }, [done, onWritten]);
  const source: Source = s => shownChunks(pen, segments, segments.findIndex(x => x.key === s.key));
  const at = segments[Math.min(pen.seg, segments.length - 1)];
  return <Block block={block} source={source} cursor={done || !at ? null : { key: at.key, stamp: pen.lastAt }} onTick={onTick} />;
}

/** How long her name takes to be signed before the card is on its way. */
const SIGN_MS = 900;

/**
 * What the card says, under her pen or the user's hand. Keyed by the title
 * from outside: a new topic wiped onto the same card starts its own pen.
 */
function NoteBody({ note, edits, still, name, signing, onSigned }: {
  note: Note; edits: NoteEdit[]; still: boolean; name: string; signing: boolean; onSigned: () => void;
}) {
  const segments = useMemo(() => letterSegments(note), [note]);
  const { pen, skip } = usePen(segments, note.status === 'writing' ? 'live' : 'instant', still);
  const writing = note.status === 'writing' || !caughtUp(pen, segments);
  const scroller = useRef<HTMLDivElement>(null);
  /** Follows the pen down while she writes, until the reader scrolls up. */
  const follow = useRef(true);
  /** Clicked into: the whole card is one text surface until the hand leaves it. */
  const [hand, setHand] = useState(false);
  /** Where the click that called it up landed, for the caret. */
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  const scrollTo = (blockId: string) => {
    const box = scroller.current;
    const line = box?.querySelector<HTMLElement>(`[data-block="${blockId}"]`);
    if (box && line) box.scrollTo({ top: Math.max(0, line.offsetTop - box.clientHeight / 3), behavior: still ? 'auto' : 'smooth' });
  };
  const { rows, resting, onWritten } = useEditPlayer({ letterId: note.id, edits, ready: !writing, still, scrollTo });

  // Follow the pen down; let a scroll up read instead.
  useEffect(() => {
    const box = scroller.current;
    if (box && (writing || signing) && follow.current) box.scrollTop = box.scrollHeight;
  });

  // Signed, it goes. Without motion the name is simply there, and it goes at once.
  useEffect(() => {
    if (!signing) return;
    const timer = window.setTimeout(onSigned, still ? 0 : SIGN_MS);
    return () => window.clearTimeout(timer);
  }, [signing]);

  const source: Source = s => shownChunks(pen, segments, segments.findIndex(x => x.key === s.key));
  const current = segments[Math.min(pen.seg, segments.length - 1)];
  const cursor: Cursor = writing && current ? { key: current.key, stamp: pen.lastAt } : null;
  const whole: Source = () => null;
  const reached = (block: LetterBlock) => pen.instant || segments.findIndex(s => s.key === blockSegments(block)[0]?.key) <= pen.seg;
  const body: Row[] = rows ?? note.blocks.filter(reached).map(block => ({ key: block.id, block, phase: 'shown' }));
  /** Still under a pen — hers or the edit player's — or under the user's own hand. */
  const settled = !writing && !rows && !signing;
  const title = segments[0]?.key === 'title' ? segments[0] : null;

  /** A tick in a check box: saved at once, every page told. */
  const tick = (blockId: string, done: boolean) => {
    void api.patchNoteBlock(blockId, { done }).catch(() => {});
  };

  return (
    <>
      <header className="flex flex-none items-baseline gap-3 px-5 pt-4 pr-16">
        <h2 className="min-w-0 flex-1 truncate font-heading text-[17px] leading-snug italic">
          {title && <Ink segment={title} source={source} cursor={cursor} />}
        </h2>
      </header>
      <div ref={scroller} onScroll={() => {
        const box = scroller.current;
        if (box) follow.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
      }} onClick={writing ? skip : settled ? event => {
        // Where the click landed is where the caret goes, once the surface is up.
        setAt({ x: event.clientX, y: event.clientY });
        setHand(true);
      } : undefined}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-1 pb-5">
        {/* The card in the user's own hand: the same lines, editable in place. */}
        {settled && hand ? <NoteSurface note={note} at={at} onRest={() => setHand(false)} /> : <>
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
                  ? <Rewrite block={block} still={still} onWritten={onWritten} onTick={tick} />
                  : settled
                    ? <Block block={block} source={whole} onTick={tick} cursor={null} />
                    : <Block block={block} source={rows ? whole : source}
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
        {/* Kept: her name at the end, in her hand, before it goes. */}
        {signing && (
          <motion.p initial={still ? false : { clipPath: 'inset(0 100% 0 0)' }} animate={{ clipPath: 'inset(0 0% 0 0)' }}
            transition={{ duration: 0.6, ease: 'easeInOut' }}
            className="mt-3 text-right font-heading text-[16px] italic">— {name}</motion.p>
        )}
      </div>
    </>
  );
}

/**
 * The note by the stage: lighter than a letter in every way. She writes it
 * here as she does a letter — the same pen, the same pace — on one small card
 * beside the stage, its top on the stage's top. It slides out from behind the
 * stage's edge as she mentions it, grows with what is on it, and folds back to
 * a paper corner when put away. Nothing on it but the words: the two things to
 * do with it come up only under the hand.
 */
export function NoteCard({ note, edits, place, name, signing, onSigned, onFold, onFile }: Props) {
  const still = useReducedMotion() ?? false;
  const ui = useUi();
  const cardRef = useRef<HTMLDivElement>(null);

  // Esc puts it away, unless a field — the card's own surface included — has the keys.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      onFold();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onFold]);

  /** Read when it leaves, so the flight starts from wherever the card is then. */
  const leave = (exit: NoteExit | undefined): TargetAndTransition => {
    if (still) return { opacity: 0, transition: { duration: 0.2 } };
    if (exit?.mode !== 'file') {
      // Back behind the stage's edge, toward the corner it leaves there.
      return { opacity: 0, x: place.side === 'outside' ? -40 : 0, scale: 0.92, transition: { duration: 0.35, ease: [0.4, 0, 1, 1] as const } };
    }
    const rect = cardRef.current?.getBoundingClientRect();
    const dx = rect ? exit.inbox.x - (rect.left + rect.width / 2) : 0;
    const dy = rect ? exit.inbox.y - (rect.top + rect.height / 2) : 0;
    // Folded in half, then small, then into the inbox.
    return {
      scaleY: [1, 0.5, 0.06], scaleX: [1, 0.96, 0.08], x: [0, 0, dx], y: [0, 0, dy], opacity: [1, 1, 0.2],
      transition: { duration: 0.9, times: [0, 0.35, 1], ease: [0.5, 0, 0.3, 1] as const },
    };
  };

  return (
    <motion.div
      ref={cardRef}
      variants={{ leave }}
      initial={still ? { opacity: 0 } : { opacity: 0, x: place.side === 'outside' ? -40 : 0, y: place.side === 'outside' ? 0 : 12 }}
      animate={{ opacity: 1, x: 0, y: 0 }}
      exit="leave"
      transition={{ duration: still ? 0.2 : 0.6, ease: [0.22, 1, 0.36, 1] }}
      style={{ position: 'absolute', width: place.width, maxHeight: place.maxHeight, ...place.at }}
      className={cn('group z-30 flex min-h-[140px] flex-col overflow-hidden rounded-[4px] bg-(--paper) text-(--paper-ink) select-none',
        'shadow-[0_18px_50px_-18px_rgb(60_20_10/0.5)] ring-1 ring-(--paper-edge)')}>
      <div className="grain pointer-events-none absolute inset-0 [--grain-opacity:0.06]" aria-hidden="true" />
      {/* The date, and in its place under the hand, the card's two acts. */}
      <span className="pointer-events-none absolute top-[19px] right-5 text-[11px] text-(--paper-quiet) tabular-nums transition-opacity duration-200 group-hover:opacity-0 group-focus-within:opacity-0">
        {dayOf(note.createdAt, ui)}
      </span>
      {!signing && (
        <div className="absolute top-3 right-2.5 z-10 flex gap-0.5 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100">
          <NoteAction label={WORDS.file[ui]} onClick={onFile}><Inbox className="size-3.5" /></NoteAction>
          <NoteAction label={WORDS.fold[ui]} onClick={onFold}><X className="size-3.5" /></NoteAction>
        </div>
      )}
      <NoteBody key={note.title} note={note} edits={edits} still={still} name={name}
        signing={signing} onSigned={onSigned} />
    </motion.div>
  );
}

/** One of the card's two acts, its name shown under it on hover. */
function NoteAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <span className="group/act relative">
      <button type="button" onClick={onClick} aria-label={label}
        className="grid size-7 place-items-center rounded-full text-(--paper-quiet)/70 transition-colors hover:text-(--paper-ink) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--paper-quiet)/50">
        {children}
      </button>
      <span role="tooltip"
        className="pointer-events-none absolute top-full left-1/2 mt-1 -translate-x-1/2 rounded-[3px] bg-(--paper-ink) px-1.5 py-0.5 text-[11px] whitespace-nowrap text-(--paper) opacity-0 transition-opacity delay-300 duration-150 group-hover/act:opacity-100">
        {label}
      </span>
    </span>
  );
}
