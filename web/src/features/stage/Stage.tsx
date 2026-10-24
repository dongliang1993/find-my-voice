import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { History } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { AppStatus, ChatMessage, CompanionStatus, Letter, Note } from '@shared/protocol';
import { MessageList } from '@/components/MessageList';
import { Inbox } from '@/features/letter/Inbox';
import { InboxButton } from '@/features/letter/InboxButton';
import { NoteCard } from '@/features/note/NoteCard';
import { Carousel, type CarouselApp } from '@/features/dock/Carousel';
import { NoteIcon } from '@/features/dock/NoteIcon';
import { SettingsIcon } from '@/features/dock/SettingsIcon';
import { recordProps } from '@/features/dock/record';
import { SettingsPanel } from '@/components/SettingsPanel';
import { Paper } from '@/features/letter/Paper';
import type { PenMode } from '@/features/letter/usePen';
import { Spiral } from '@/components/Spiral';
import { MAT, ORB_SLOT_TOP, STAGE_CAPTION, STAGE_COIL, STAGE_LINE, STAGE_PANEL } from '@/features/onboarding/layout';
import { HINTS } from '@/features/onboarding/script';
import { Orb } from '@/features/orb/Orb';
import { useEar } from '@/features/orb/useEar';
import { useHint } from '@/features/orb/useHint';
import { api } from '@/lib/api';
import { audio } from '@/lib/audio';
import { microphone } from '@/lib/microphone';
import { cn } from '@/lib/utils';
import { useIdleChrome } from '@/hooks/useIdleChrome';
import { useAmbientTheme, type Mood } from '@/features/stage/ambient';
import { latestLine } from '@/features/stage/line';
import { STAGE_REST, stageState, VISUALS } from '@/features/stage/state';
import { Caption } from '@/features/stage/Caption';
import type { LetterEdit, NoteEdit, SpeechLines } from '@/hooks/useChat';

/** Her emotion, mapped onto the four moods the light knows. */
const moodOf = (emotion: string | null | undefined): Mood =>
  emotion === 'happy' ? 'happy' : emotion === 'low' || emotion === 'sad' ? 'low'
    : emotion === 'longing' ? 'longing' : 'calm';

/**
 * How long the stage waits, the first time, before she says how to answer.
 * Longer than any question in the first meeting: she has just said something
 * that wants no reply, and a silence after it is not being stuck.
 */
const STAGE_HINT_MS = 20000;

/**
 * Her last letter stays by the circle until she writes another — within
 * reason: one from yesterday is in the inbox, not on the stage. Matches how
 * long the server still treats it as the letter "on the stage".
 */
const STAGE_LETTER_MS = 12 * 3600_000;

/**
 * How the pen starts when a letter is opened. From the stage, a letter not yet
 * read is written out — as she writes it, or again from the top, faster, if
 * she finished first. Read before, or opened from the history, it is simply
 * there; one still being written picks up where she is.
 */
function penMode(letter: Letter, fromStage: boolean): PenMode {
  if (letter.status === 'writing') return fromStage && !letter.openedAt ? 'live' : 'resume';
  if (fromStage && !letter.openedAt && letter.status === 'done') return 'replay';
  return 'instant';
}

type Props = {
  messages: ChatMessage[];
  status: CompanionStatus;
  name: string;
  /** The audio id that is audible right now, if any. */
  playing: string | null;
  /** Sentence boundaries the server sent, by audio id. */
  lines: SpeechLines;
  onSend: (text: string) => void;
  onInterrupt: () => void;
  needsSetup: boolean;
  online: boolean;
  /** Speech-to-text is configured, so the circle can listen. */
  canListen: boolean;
  /** Just came out of the first meeting: the stage was drawn by it, so nothing here may pop in. */
  arrived: boolean;
  /** Her letters, newest first, and the edits she has made to them. */
  letters: Letter[];
  edits: LetterEdit[];
  /** The one note on the table, and the edits she has made to it. */
  note: Note | null;
  noteEdits: NoteEdit[];
  /** The notes taken off the table and kept: what the dock holds. */
  filedNotes: Note[];
  /** The apps' one window on the stage: which one is up, and nothing. */
  appStatus: AppStatus;
  /** Tells the server which letter is open, so what the user says next is about it. */
  onReading: (letterId: string | null) => void;
};

/**
 * The main screen, after the film: one coral stage in a cream room, and both
 * of you on it. Your words arrive as subtitles, hers as the large line under
 * the coil; the circle sits on the mat, the same one that took your answers in
 * the first meeting. The thread is behind the history button — the stage
 * itself stays uncluttered.
 *
 * The light follows the hour and her mood, the chrome steps back when you stop
 * moving, and everything that changes does so slowly, so nothing snaps.
 */
export function Stage({
  messages, status, name, playing, lines, onSend, onInterrupt,
  needsSetup, online, canListen, arrived, letters, edits, note, noteEdits, filedNotes, appStatus, onReading,
}: Props) {
  const room = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  /** The inbox, up from the bottom-left; one screen at a time. */
  const [inboxOpen, setInboxOpen] = useState(false);
  /** The app window up on the stage; only one is ever up at once. */
  const [app, setApp] = useState<'settings' | null>(null);
  // First visit without a model: settings rise straight away, once — never again on a status refresh.
  useEffect(() => { if (needsSetup) setApp('settings'); }, []);
  /** The letter open on the paper, and how its pen started. */
  const [reading, setReading] = useState<{ id: string; mode: PenMode } | null>(null);
  /** Her line opened up to the whole reply; a new line closes it again. */
  const [expanded, setExpanded] = useState(false);
  /** The same, while a mouse only rests on it — gone again when it leaves. */
  const [preview, setPreview] = useState(false);
  const [lastSaid, setLastSaid] = useState('');
  /** The user has said or typed something here: they know how, no hint needed. */
  const [spoken, setSpoken] = useState(false);
  const still = useReducedMotion() ?? false;

  const say = (text: string) => {
    onSend(text);
    setLastSaid(text);
    setSpoken(true);
  };
  // The server only turns the clip into words; sending stays on the socket path.
  const ear = useEar(async (clip, mime) => {
    const text = (await api.hear(clip, mime).catch(() => null))?.text.trim();
    if (text) say(text);
  });
  const listening = ear.ear === 'listening';

  const state = stageState({ status, playing: playing !== null, listening });
  const visual = VISUALS[state];
  useAmbientTheme(room, moodOf(messages.at(-1)?.emotion));
  // The buttons step back while nothing is happening; they stay put while you speak.
  const hidden = useIdleChrome(3000, listening, arrived);

  // She draws breath once as she starts to think.
  useEffect(() => { if (state === 'thinking') audio.breath(); }, [state]);

  const aside = useHint(arrived && !spoken && state === 'idle' && ear.ear === 'off' && !draft.trim() ? 'stage' : null,
    STAGE_HINT_MS, HINTS.stage);

  const talk = (mode: 'tap' | 'hold') => {
    // Talking over her is how you interrupt her.
    if (state === 'speaking') onInterrupt();
    setLastSaid('');
    setSpoken(true);
    void ear.start(mode);
  };

  const send = (text: string) => {
    if (!online) return;
    say(text);
    setDraft('');
  };

  const mine = latestLine(messages, playing);
  // A hint is one fixed archive with no sentence boundaries of its own, so it
  // is paced by reading speed like a silent reply — but its audio id is still
  // worth passing, so the line waits for the clip instead of running ahead.
  const hint = aside ? { id: HINTS.stage.key, text: aside, audioId: `hint-${HINTS.stage.key}` } : null;
  const line = hint ?? mine;
  // A new line starts collapsed; the whole of the last one is still a click away.
  useEffect(() => { setExpanded(false); setPreview(false); }, [line?.id]);
  const open = expanded || preview;
  const caption = listening ? '' : lastSaid;

  // ---- letters ----
  /** A letter picked in the history: it opens as the inbox's paper. */
  const openFromInbox = useCallback((letter: Letter) => {
    setReading({ id: letter.id, mode: penMode(letter, false) });
    setHistoryOpen(false);
    setInboxOpen(true);
    onReading(letter.id);
    if (!letter.openedAt) void api.openLetter(letter.id).catch(() => {});
  }, [onReading]);
  const closePaper = useCallback(() => {
    setReading(null);
    onReading(null);
  }, [onReading]);
  const openLetter = reading ? letters.find(l => l.id === reading.id) : undefined;
  // Deleted elsewhere while open: there is nothing left to show.
  useEffect(() => { if (reading && !openLetter) closePaper(); }, [reading, openLetter, closePaper]);
  /** The wax on the inbox's envelope: red while a finished letter waits unread. */
  const seal = letters.some(l => !l.openedAt && l.status !== 'writing') ? 'filled' : letters.length ? 'hollow' : 'none';
  /**
   * The first meeting's film layer fades out on the way here; this one fades
   * back in. The grain fades through its variable: an opacity on the layer
   * itself would cut its blend off from the stage under it.
   */
  const fade = { duration: 1.2 };
  const grain = arrived ? { initial: { '--grain-opacity': 0 }, animate: { '--grain-opacity': 0.16 }, transition: fade } : {};
  const vignette = arrived ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: fade } : {};

  /** The stack's cards, from what is up on the table and what is kept.
   * Memoised: a fresh array would rebuild every texture on every render. */
  const appItems: CarouselApp[] = useMemo(() => [
    { id: 'note', label: filedNotes.length ? (filedNotes[0]!.title || '便签') : '便签', icon: <NoteIcon /> },
    { id: 'settings', label: '设置', icon: <SettingsIcon /> },
  ], [filedNotes]);

  return (
    <div ref={room}
      className="relative isolate flex h-dvh items-stretch justify-center overflow-hidden bg-(--base) text-(--ink) transition-colors duration-[2500ms] sm:items-center sm:p-8">
      {/* The app stack, one layer under the stage: the cards lie behind the
          panel, only their edges showing past it. The hand on the dock
          rolls them; a click on the front card opens it. */}
      <Carousel apps={appItems} still={still} hidden={hidden && !inboxOpen}
        onPick={id => {
          if (id === 'settings') setApp(app => app === 'settings' ? null : 'settings');
          // The note card is the note icon's act, one step over: back onto the table.
          else if (id === 'note' && filedNotes.length) void api.unfileNote(filedNotes[0]!.id).catch(() => {});
        }}
        onFront={id => { if (id !== 'settings') setApp(null); }} />
      {/* The room breathes while she speaks, as it did in the first meeting. */}
      <div className="glow pointer-events-none absolute inset-x-0 top-0 -z-10 h-[70%]" aria-hidden="true" />
      {/* The first meeting's card, exactly: a coral panel over a cream mat, both
          measured by the same variables, so moving between the two never resizes. */}
      <main className="on-stage relative flex h-full w-full max-w-[880px] flex-col overflow-hidden bg-(--her) text-white transition-[background-color,filter] duration-[2500ms] sm:h-auto sm:rounded-[3px] sm:shadow-(--panel-shadow) sm:ring-1 sm:ring-hairline"
        style={{ filter: `brightness(${visual.herBrightness})` }}>
        {/* Laid over the panel, not in the flow: the card's height is the panel
            plus the mat, exactly as in the first meeting. */}
        <header className={cn('absolute inset-x-0 top-0 z-20 flex items-center justify-between px-6 pt-[calc(1rem+env(safe-area-inset-top))] pb-2 transition-opacity duration-500', hidden && 'pointer-events-none opacity-0')}>
          <span className="font-heading text-[20px] italic opacity-85">{name}</span>
          <button type="button" onClick={() => setHistoryOpen(open => !open)} aria-label="历史" aria-pressed={historyOpen}
            className="grid size-9 place-items-center rounded-full ring-1 ring-white/40 transition-colors hover:bg-white/10">
            <History className="size-4" />
          </button>
        </header>

        {/* Her half: the panel, at the panel's own height. Her coil sits on a
            fixed line rather than being centred with her words — otherwise every
            extra line of text pushes it up, and it never rests in one place. */}
        <section className={cn(STAGE_PANEL, 'transition-colors duration-[2500ms]')}>
          <p aria-live="polite"
            className={cn(STAGE_CAPTION, 'transition-[color,opacity] duration-500', caption ? 'text-white/75' : 'text-white/0', open && 'opacity-0')}>
            {caption}
          </p>
          {/* Her coil, the same one the first meeting draws: it is her presence,
              not a level meter, so it stays even when the room is silent. It steps
              aside only while her whole reply is open over it — through motion, not
              a class, as a layoutId element carries its own inline opacity. */}
          <motion.div layoutId="her-spiral" animate={{ opacity: open ? 0 : 1 }} transition={{ opacity: { duration: 0.3 } }}
            className={cn(STAGE_COIL, 'text-white [--spiral:#fff]')}>
            <Spiral thinking={state === 'thinking'} stage="awake" listening={state === 'listening'}
              rest={STAGE_REST} weight={1 / 70} className="size-full" />
          </motion.div>
          {/* Opened, the whole reply is laid over the coil rather than making room
              for itself, so the column keeps its shape and nothing jumps. */}
          <div aria-live="polite" className={cn('w-full', STAGE_LINE)}>
            {line && (
              <Caption messageId={line.id} text={line.text} audioId={line.audioId}
                timed={line.audioId ? lines[line.audioId] ?? null : null}
                expanded={expanded} preview={preview} onPreview={setPreview}
                onToggle={() => setExpanded(open => !open)}
                opacity={visual.lineOpacity} />
            )}
          </div>
        </section>

        {/* Your half: the mat, with the circle just under the line. Nothing else is
            down here once the questions are over, so it does not hide at the middle. */}
        <footer className={cn('relative', MAT)}>
          <div className={ORB_SLOT_TOP}>
            <motion.div layoutId="orb">
              <Orb ear={ear.ear} canSpeak={canListen && microphone.supported && !ear.denied} dim={visual.mic === 'dim'}
                value={draft} onChange={setDraft} onSend={send} onStart={talk} onStop={ear.stop} onCancel={ear.cancel}
                label="消息" />
            </motion.div>
          </div>
        </footer>

        {/* Film: grain over everything, and a vignette that closes the corners.
            Both are inert; the grain is a static tile, so it costs one paint. */}
        <motion.div {...grain} className="grain grain-live pointer-events-none absolute z-5 [--grain-opacity:0.16]" aria-hidden="true" />
        <motion.div {...vignette} className="pointer-events-none absolute inset-0 z-5 bg-[radial-gradient(ellipse_at_center,transparent_55%,rgb(60_20_10/0.22))]" aria-hidden="true" />
      </main>

      {/* The thread slides in from the right edge of the stage, on the same mat the card sits on. */}
      <div className={cn('absolute inset-x-4 bottom-4 z-20 max-h-[62dvh] overflow-hidden rounded-[6px] bg-card text-foreground shadow-(--panel-shadow) ring-1 ring-hairline transition-[opacity,transform] duration-500 sm:inset-x-auto sm:right-[calc(2rem+1px)] sm:bottom-[calc(2rem+1px)] sm:w-[380px]',
        historyOpen ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0')}>
        <div className="flex h-[54dvh] flex-col sm:h-[46dvh]">
          <div className="min-h-0 flex-1">
            <MessageList messages={messages} status={status} name={name} letters={letters}
              onOpenLetter={openFromInbox} />
          </div>
        </div>
      </div>

      {/* The inbox: her letters, from the bottom-left. The list on the left,
          the paper on the right; the one still being written stays at the top. */}
      <AnimatePresence>
        {inboxOpen && (
          <motion.div key="inbox" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 16 }}
            transition={{ duration: still ? 0 : 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-x-4 bottom-4 top-20 z-30 overflow-hidden rounded-[6px] bg-(--paper) text-(--paper-ink) shadow-(--panel-shadow) ring-1 ring-hairline sm:inset-x-auto sm:right-[calc(2rem+1px)] sm:bottom-[calc(2rem+1px)] sm:left-[calc(2rem+1px)] sm:top-24">
            <Inbox letters={letters} openId={reading?.id ?? null}
              paper={openLetter && (
                <Paper embedded key={openLetter.id} letter={openLetter} mode={reading!.mode} edits={edits}
                  caption={caption} herLine={mine?.text ?? ''}
                  thinking={state === 'thinking'} listening={state === 'listening'} onClose={closePaper} />
              )}
              onOpen={openFromInbox} onDelete={letter => void api.deleteLetter(letter.id).catch(() => {})} onClose={() => setInboxOpen(false)} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* The inbox's entry: an envelope by the bottom-left corner, the seal red
          while something waits unread. Nothing in it yet — nothing to find —
          the envelope waits in with the rest of the chrome. */}
      {/* Hidden for now, letters or not: history is the way in. Commented, not deleted.
      <div className={cn('absolute bottom-6 left-6 z-20 transition-opacity duration-500',
        (hidden || !letters.length) && !inboxOpen && 'pointer-events-none opacity-0',
        inboxOpen && 'invisible')}>
        <InboxButton seal={seal} open={inboxOpen} onToggle={() => setInboxOpen(open => !open)} />
      </div>
      */}

      {/* The apps' windows, one stage between them: the record change —
          the next one up from behind the dock, the last one walking
          toward you and gone. */}
      <AnimatePresence>
        {app === 'settings' && (
          <motion.div key="settings" {...recordProps(still)} className="absolute inset-0">
            <SettingsPanel status={appStatus} onSaved={() => setApp(null)} onClose={() => setApp(null)} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* The note on the table, by the right edge: what is only wanted on the
          spot. Closing it takes it away for good — nothing is kept. */}
      <AnimatePresence>
        {note && <NoteCard key="note" note={note} edits={noteEdits} onClose={() => {}} onFile={() => { void api.fileNote().catch(() => {}); }} />}
      </AnimatePresence>
    </div>
  );
}
