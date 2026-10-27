import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { History, Pause, Play, RotateCcw } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { AppStatus, ChatMessage, CompanionStatus, DemoCue, Paper } from '@shared/protocol';
import { MessageList } from '@/components/MessageList';
import { Papers } from '@/features/paper/Papers';
import { PaperCard } from '@/features/paper/PaperCard';
import { PaperCorner } from '@/features/paper/PaperCorner';
import { SavedDot, type Flight } from '@/features/paper/SavedDot';
import { placePaper, type StageBox } from '@/features/paper/place';
import { Switcher, type SwitcherApp, type SwitcherHandle } from '@/features/dock/Switcher';
import { HomeIcon } from '@/features/dock/HomeIcon';
import { PapersIcon } from '@/features/dock/PapersIcon';
import { SettingsIcon } from '@/features/dock/SettingsIcon';
import { APP_SWITCH, APP_SWITCH_STILL, FORWARD, RECEDED, RECEDED_STILL } from '@/features/dock/appSwitch';
import { SettingsPanel, type Page as SettingsPage } from '@/components/SettingsPanel';
import { AppSheet } from '@/features/dock/AppSheet';
import { toast } from 'sonner';
import { useWords } from '@/lib/locale';
import { Spiral } from '@/components/Spiral';
import { MAT, ORB_SLOT_TOP, VIGNETTE, STAGE_CAPTION, STAGE_CAPTION_TEXT, STAGE_COIL, STAGE_LINE, STAGE_PANEL } from '@/features/onboarding/layout';
import { HINTS } from '@/features/onboarding/script';
import { Orb } from '@/features/orb/Orb';
import { useEar } from '@/features/orb/useEar';
import { useHint } from '@/features/orb/useHint';
import { api } from '@/lib/api';
import { audio } from '@/lib/audio';
import { microphone } from '@/lib/microphone';
import { cn } from '@/lib/utils';
import { useIdleChrome } from '@/hooks/useIdleChrome';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useAmbientTheme, type Mood } from '@/features/stage/ambient';
import { useTimelapse } from '@/features/stage/useTimelapse';
import { lapseBetween } from '@/features/stage/timelapse';
import { lastTake, latestLine } from '@/features/stage/line';
import { usePaused } from '@/hooks/useVoice';
import { ASLEEP, STAGE_REST, stageState, VISUALS } from '@/features/stage/state';
import { Caption } from '@/features/stage/Caption';
import type { PaperEdit, SpeechLines } from '@/hooks/useChat';

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
type View = 'home' | 'papers' | 'settings';

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
  /** Every paper still around, newest first, the edits she has made to them, and the one on the stage. */
  papers: Paper[];
  edits: PaperEdit[];
  stage: string | null;
  /** The paper last saved, for the moment it goes onto the list. */
  saved: { seq: number; paperId: string } | null;
  appStatus: AppStatus;
  /** Bumped when she changed a setting because she was asked to: an open settings page reads them again. */
  settingsStamp: number;
  /** Tells the server which paper is open in Papers, so what the user says next is about it. */
  onReading: (paperId: string | null) => void;
  /** Until when she rests after a goodbye; null while she is up. */
  resting: string | null;
  /** Any touch while she rests. */
  onWake: () => void;
  /** Demo mode: the time the scene is set at, and what the script last had the page do. */
  demo?: { clock: string | null; cue: { seq: number; cue: DemoCue } | null } | null;
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
  needsSetup, online, canListen, arrived, papers, edits, stage, saved, appStatus, settingsStamp, onReading, resting, onWake, demo = null,
}: Props) {
  const room = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const switcher = useRef<SwitcherHandle>(null);
  const [draft, setDraft] = useState('');
  /** The circle has grown into a field: the user is typing to her. */
  const [typing, setTyping] = useState(false);
  const [keystroke, setKeystroke] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** What the switcher has up: the stage itself, the inbox, or settings — one at a time. */
  const [view, setView] = useState<View>('home');
  /** The app last opened: the switcher keeps it in front after it closes, so the way back is one click. */
  const [shelf, setShelf] = useState<View>('home');
  /** An app is up in the stage's place, so the stage steps back behind it. */
  const away = view !== 'home';
  const closeApp = useCallback(() => setView('home'), []);
  const openView = useCallback((next: View) => { setView(next); setShelf(next); }, []);
  // First visit without a model: settings rise straight away, once — never again on a status refresh.
  useEffect(() => { if (needsSetup) openView('settings'); }, []);
  /** The paper open in Papers. */
  const [reading, setReading] = useState<string | null>(null);
  /** Her line opened up to the whole reply; a new line closes it again. */
  const [expanded, setExpanded] = useState(false);
  /** The same, while a mouse only rests on it — gone again when it leaves. */
  const [preview, setPreview] = useState(false);
  const [lastSaid, setLastSaid] = useState('');
  /** The user has said or typed something here: they know how, no hint needed. */
  const [spoken, setSpoken] = useState(false);
  const still = useReducedMotion() ?? false;
  const word = useWords();
  const paused = usePaused();
  /** Bumped by each replay, so her line starts over from its first sentence. */
  const [replays, setReplays] = useState(0);

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
  // Resting goes dark only once her goodbye has been heard out — never over her own last words.
  const asleep = Boolean(resting) && state === 'idle';
  const visual = asleep ? ASLEEP : VISUALS[state];
  const mood = moodOf(messages.at(-1)?.emotion);
  /** A day of light run for recording; while it runs, it paints the room and the chrome is away. */
  const cue = demo?.cue ?? null;
  const lapse = useMemo(() => (cue?.cue.type === 'timelapse' ? { seq: cue.seq, lapse: lapseBetween(cue.cue.from, cue.cue.to, cue.cue.durationMs) } : null), [cue]);
  const lapsing = useTimelapse(room, mood, lapse);
  const clock = useMemo(() => (demo?.clock ? new Date(demo.clock) : undefined), [demo?.clock]);
  const ambient = useAmbientTheme(room, mood, { now: clock, held: lapsing });
  // The buttons step back while nothing is happening; they stay put while you speak.
  const idle = useIdleChrome(3000, listening, arrived);
  const hidden = idle || asleep;

  // Any touch brings her back: a click, a key, the circle. Not one that only wakes the screen.
  useEffect(() => {
    if (!resting) return;
    const up = (event: Event) => {
      if (event instanceof KeyboardEvent && ['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
      onWake();
    };
    window.addEventListener('pointerdown', up);
    window.addEventListener('keydown', up);
    return () => { window.removeEventListener('pointerdown', up); window.removeEventListener('keydown', up); };
  }, [resting, onWake]);

  // She draws breath once as she starts to think.
  useEffect(() => { if (state === 'thinking') audio.breath(); }, [state]);

  // A demo plays to a script; she does not prompt the person recording it.
  const aside = useHint(!demo && arrived && !spoken && state === 'idle' && ear.ear === 'off' && !draft.trim() ? 'stage' : null,
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

  // ---- her coil: say it again ----
  const take = lastTake(messages);
  /** Speaking, a click holds her or lets her go on; quiet, it has her say her last turn again. */
  // A typed line can be said only with a voice set up to say it.
  const replayable = take && (take.audioId || appStatus.voice.ready);
  const coil = state === 'speaking' ? (paused ? 'resume' : 'pause') : state === 'idle' && replayable && !open ? 'replay' : null;
  const onCoil = () => {
    if (coil === 'pause' || coil === 'resume') { audio.togglePause(); return; }
    if (coil !== 'replay' || !take) return;
    setReplays(n => n + 1);
    // Said before: played back as it was. Only typed: said now, once, and kept for next time.
    if (take.audioId) void audio.playClip(take.audioId, api.audioUrl(take.audioId)).catch(() => {});
    else void api.voiceMessage(take.messageId).catch(() => {});
  };

  // ---- papers ----
  /** A paper picked in Papers: open on the right, and what she is asked about next. */
  const readPaper = useCallback((paper: Paper | null) => {
    setReading(paper?.id ?? null);
    onReading(paper?.id ?? null);
  }, [onReading]);
  const kept = useMemo(() => papers.filter(p => p.savedAt), [papers]);
  const wide = useMediaQuery('(min-width: 640px)');
  /** The paper the demo script opens Papers on, instead of the newest. */
  const pick = useRef<string | null>(null);
  // Opened side by side, Papers opens on the newest; on a phone, on the list.
  useEffect(() => {
    if (view !== 'papers' || !wide) return;
    const first = kept.find(p => p.id === pick.current) ?? kept[0];
    pick.current = null;
    if (first) readPaper(first);
  }, [view]);
  const [settingsPage, setSettingsPage] = useState<SettingsPage | undefined>(undefined);
  useEffect(() => {
    if (cue?.cue.type !== 'openApp') return;
    const { app, select, tab } = cue.cue;
    if (app === 'settings') { setSettingsPage(tab); openView('settings'); return; }
    const paper = kept.find(p => p.id === select);
    if (view === 'papers' && paper) readPaper(paper);
    pick.current = select ?? null;
    openView('papers');
  }, [cue?.seq]);
  // Deleted elsewhere while open, or Papers closed: nothing is open any more.
  useEffect(() => { if (reading && (view !== 'papers' || !kept.some(p => p.id === reading))) readPaper(null); }, [reading, view, kept, readPaper]);
  /** A card in the history: its paper back on the stage. */
  const stageFromHistory = useCallback((paper: Paper) => {
    setHistoryOpen(false);
    void api.stagePaper(paper.id).catch(() => {});
  }, []);
  /**
   * The first meeting's grain fades out on the way here; this one fades back
   * in. Its vignette is the stage's own, so that one simply stays. The grain fades through its variable: an opacity on the layer
   * itself would cut its blend off from the stage under it.
   */
  const fade = { duration: 1.2 };
  const grain = arrived ? { initial: { '--grain-opacity': 0 }, animate: { '--grain-opacity': 0.16 }, transition: fade } : {};

  const apps: SwitcherApp[] = useMemo(() => [
    { id: 'home', label: word('home'), icon: <HomeIcon className="size-full" /> },
    { id: 'papers', label: word('papers'), icon: <PapersIcon className="size-full" /> },
    { id: 'settings', label: word('settings'), icon: <SettingsIcon className="size-full" /> },
  ], [word]);

  // ---- the paper on the stage ----
  /** The stage's box in the room, for the paper to sit beside. */
  const [box, setBox] = useState<StageBox | null>(null);
  useLayoutEffect(() => {
    const outer = room.current;
    const stage = stageRef.current;
    if (!outer || !stage) return;
    // Layout offsets, not client rects: the stage is scaled while it steps back, and its place is its unscaled one.
    const measure = () => {
      const left = stage.offsetLeft;
      const top = stage.offsetTop;
      setBox({ left, top, right: left + stage.offsetWidth, bottom: top + stage.offsetHeight, roomW: outer.clientWidth, roomH: outer.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);
  const place = box ? placePaper(box) : null;
  const frame = box && { left: box.left, top: box.top, width: box.right - box.left, height: box.bottom - box.top };
  const presence = { thinking: state === 'thinking', listening: state === 'listening' };
  const onStage = stage ? papers.find(p => p.id === stage) : undefined;
  /** Put away to its corner: still on the stage, out of the way until it is wanted. */
  const [folded, setFolded] = useState(false);
  // A new paper comes out to be read; so does one she goes back to write on or change.
  useEffect(() => { setFolded(false); }, [onStage?.id]);
  useEffect(() => { if (onStage?.status === 'writing') setFolded(false); }, [onStage?.status]);
  useEffect(() => { if (edits.at(-1)?.after.id === onStage?.id) setFolded(false); }, [edits.length]);
  const fold = useCallback(() => setFolded(true), []);
  /** A paper just taken from Papers, and where it was there: the card flies from that spot. */
  const [arrival, setArrival] = useState<{ paperId: string; from: DOMRect } | null>(null);
  // One flight only: gone once it has landed (or the stage never answered), so a later return does not fly again.
  useEffect(() => {
    if (!arrival) return;
    const timer = window.setTimeout(() => setArrival(null), 1500);
    return () => window.clearTimeout(timer);
  }, [arrival]);
  /** What her column leaves free on the right while a paper shares the stage. */
  const reserve = onStage && place && !folded ? place.reserve : 0;
  const shift = { duration: still ? 0 : 0.6, ease: [0.22, 1, 0.36, 1] as const };

  // Saved — by a click here, by her, on another page: said once, and the card's dot flies to Papers.
  const [flight, setFlight] = useState<Flight | null>(null);
  useEffect(() => {
    if (!saved) return;
    toast(word('saved'));
    const card = saved.paperId === stage ? document.querySelector('[data-stage-paper]')?.getBoundingClientRect() : null;
    const to = switcher.current?.center('papers');
    if (card && to) setFlight({ seq: saved.seq, from: { x: card.right - 24, y: card.top + 24 }, to });
  }, [saved?.seq]);

  return (
    <div ref={room} {...ambient} data-timelapse={lapsing || undefined}
      className="relative isolate flex h-dvh items-stretch justify-center overflow-hidden bg-(--base) pt-(--titlebar) text-(--ink) transition-colors duration-[2500ms] sm:items-center sm:p-8">
      {/* The room breathes while she speaks, as it did in the first meeting. */}
      <div className="room-light pointer-events-none absolute inset-0 -z-10" aria-hidden="true" />
      <div className="glow pointer-events-none absolute inset-x-0 top-0 -z-10 h-[70%]" aria-hidden="true" />
      {/* The first meeting's card, exactly: a coral panel over a cream mat, both
          measured by the same variables, so moving between the two never resizes. */}
      {/* The stage's frame. Another app up in front, it steps back as a card does in the switcher. */}
      <motion.div ref={stageRef} initial={false} inert={away}
        animate={away ? (still ? RECEDED_STILL : RECEDED) : FORWARD} transition={still ? APP_SWITCH_STILL : APP_SWITCH}
        className="flex h-full w-full max-w-[880px] flex-col sm:h-auto">
      <main className="on-stage relative flex h-full w-full max-w-[880px] flex-col overflow-hidden bg-(--her) text-white transition-[background-color,filter] duration-[2500ms] sm:h-auto sm:rounded-[3px] sm:shadow-(--panel-shadow) sm:ring-1 sm:ring-hairline"
        // Dimmed for the night, saturation held up with it: dark and warm, not dark and grey.
        style={{ filter: `brightness(${visual.herBrightness})${asleep ? ' saturate(1.15)' : ''}` }}>
        {/* Laid over the panel, not in the flow: the card's height is the panel
            plus the mat, exactly as in the first meeting. */}
        {/* With a paper on the right, the history button keeps to the red side, against the paper's edge. */}
        <motion.header data-chrome initial={false} animate={{ right: reserve }} transition={shift}
          className={cn('absolute left-0 top-0 z-20 flex items-center justify-between px-6 pt-[calc(1rem+env(safe-area-inset-top))] pb-2 transition-opacity duration-500', hidden && 'pointer-events-none opacity-0')}>
          <span className="font-heading text-[20px] italic opacity-85">{name}</span>
          <button type="button" onClick={() => setHistoryOpen(open => !open)} aria-label={word('history')} aria-pressed={historyOpen}
            className="grid size-9 place-items-center rounded-full ring-1 ring-white/40 transition-colors hover:bg-white/10">
            <History className="size-4" />
          </button>
        </motion.header>

        {/* Her half: the panel, at the panel's own height. Her coil sits on a
            fixed line rather than being centred with her words — otherwise every
            extra line of text pushes it up, and it never rests in one place. */}
        {/* With a paper sharing the stage, the column keeps to the left of it — a
            margin, not padding: her opened reply is laid out against this box. */}
        <motion.section initial={false} animate={{ marginRight: reserve }} transition={shift}
          className={cn(STAGE_PANEL, 'transition-colors duration-[2500ms]')}>
          <div data-chrome className={STAGE_CAPTION}>
            <p aria-live="polite"
              className={cn(STAGE_CAPTION_TEXT, 'transition-[color,opacity] duration-500', caption ? 'text-white/75' : 'text-white/0', open && 'opacity-0')}>
              {caption}
            </p>
          </div>
          {/* Her coil, the same one the first meeting draws: it is her presence,
              not a level meter, so it stays even when the room is silent. It steps
              aside only while her whole reply is open over it — through motion, not
              a class, as a layoutId element carries its own inline opacity. */}
          <motion.div layoutId="her-spiral" animate={{ opacity: open ? 0 : 1 }} transition={{ opacity: { duration: 0.3 } }}
            className={cn(STAGE_COIL, 'text-white [--spiral:#fff]')}>
            <button type="button" onClick={onCoil} disabled={!coil}
              aria-label={coil === 'pause' ? word('pause') : coil === 'resume' ? word('resume') : word('replay')}
              className={cn('group relative block size-full transition-[filter] duration-300 focus-visible:outline-none',
                coil ? 'cursor-pointer hover:drop-shadow-[0_0_10px_rgb(255_255_255/0.45)]' : 'cursor-default')}>
              <Spiral thinking={state === 'thinking'} listening={state === 'listening'}
                typing={typing && state !== 'speaking'} keystroke={keystroke}
                rest={STAGE_REST} weight={1 / 70} className="size-full" />
              {/* Just past the coil's right end. Held, it stays: a stopped voice should say how to go on. */}
              <span aria-hidden="true" className={cn('pointer-events-none absolute top-1/2 left-full ml-1 -translate-y-1/2 text-white/70 transition-opacity duration-300',
                coil === 'resume' ? 'opacity-100' : coil ? 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100' : 'opacity-0')}>
                {coil === 'pause' ? <Pause className="size-3.5" /> : coil === 'resume' ? <Play className="size-3.5" /> : <RotateCcw className="size-3.5" />}
              </span>
            </button>
          </motion.div>
          {/* Opened, the whole reply is laid over the coil rather than making room
              for itself, so the column keeps its shape and nothing jumps. */}
          {/* Sharing the stage, her line gives up only a little of its size: the left still holds two lines of it. */}
          <div data-chrome aria-live="polite" className={cn('w-full transition-[font-size] duration-500', STAGE_LINE)}
            style={reserve ? { fontSize: 'clamp(24px, 2.2vw, 33px)' } : undefined}>
            {line && (
              <Caption key={`${line.id}:${replays}`} messageId={line.id} text={line.text} audioId={line.audioId}
                timed={line.audioId ? lines[line.audioId] ?? null : null}
                expanded={expanded} preview={preview} onPreview={setPreview}
                onToggle={() => setExpanded(open => !open)}
                opacity={visual.lineOpacity} />
            )}
          </div>
        </motion.section>

        {/* Your half: the mat, with the circle just under the line. Nothing else is
            down here once the questions are over, so it does not hide at the middle. */}
        <footer className={cn('relative', MAT)}>
          <motion.div data-chrome initial={false} animate={{ right: reserve }} transition={shift} className={ORB_SLOT_TOP}>
            <motion.div layoutId="orb">
              <Orb ear={ear.ear} canSpeak={canListen && microphone.supported && !ear.denied} dim={visual.mic === 'dim'}
                value={draft} onChange={value => { setDraft(value); setKeystroke(n => n + 1); }}
                onSend={send} onStart={talk} onStop={ear.stop} onCancel={ear.cancel}
                onTypingChange={setTyping} label="消息" placeholder="说点什么" />
            </motion.div>
          </motion.div>
        </footer>

        {/* The paper on the stage's right, top to bottom: the stage in two, not a card over it. */}
        <AnimatePresence>
          {onStage && place && !folded && (
            <PaperCard key={onStage.id} paper={onStage} edits={edits} width={place.width} signer={name} onFold={fold}
              from={arrival?.paperId === onStage.id ? arrival.from : undefined}
              onSave={() => void api.savePaper(onStage.id).catch(() => {})}
              onClose={() => void api.closeStage().catch(() => {})} />
          )}
        </AnimatePresence>

        {/* Film: grain over everything, and a vignette that closes the corners.
            Both are inert; the grain is a static tile, so it costs one paint. */}
        <motion.div {...grain} className="grain grain-live pointer-events-none absolute z-5 [--grain-opacity:0.16]" aria-hidden="true" />
        <div className={VIGNETTE} aria-hidden="true" />
      </main>
      </motion.div>

      {/* The thread slides in from the right edge of the stage, on the same mat the card sits on. */}
      <div className={cn('absolute inset-x-4 bottom-4 z-20 max-h-[62dvh] overflow-hidden rounded-[6px] bg-card text-foreground shadow-(--panel-shadow) ring-1 ring-hairline transition-[opacity,transform] duration-500 sm:inset-x-auto sm:right-[calc(2rem+1px)] sm:bottom-[calc(2rem+1px)] sm:w-[380px]',
        historyOpen ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0')}>
        <div className="flex h-[54dvh] flex-col sm:h-[46dvh]">
          <div className="min-h-0 flex-1">
            <MessageList messages={messages} status={status} name={name} papers={papers}
              onOpenPaper={stageFromHistory} />
          </div>
        </div>
      </div>

      {/* The other apps, each in the stage's own frame while the stage steps back behind it. */}
      <AnimatePresence>
        {view === 'papers' && (
          <AppSheet key="papers" title={word('papers')} frame={frame} presence={presence} onClose={closeApp}>
            <Papers papers={kept} edits={edits} openId={reading}
              onOpen={readPaper} onDelete={paper => void api.deletePaper(paper.id).catch(() => {})}
              signer={name}
              onStage={(paper, from) => {
                if (from) setArrival({ paperId: paper.id, from });
                setFolded(false);
                void api.stagePaper(paper.id).catch(() => {});
                closeApp();
              }} />
          </AppSheet>
        )}
        {view === 'settings' && (
          <SettingsPanel key="settings" initialPage={settingsPage} status={appStatus} stamp={settingsStamp} onClose={closeApp}
            frame={frame} presence={presence} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {onStage && place && folded && <PaperCorner key="corner" place={place} onOpen={() => setFolded(false)} />}
      </AnimatePresence>
      <SavedDot flight={flight} onDone={() => setFlight(null)} />

      {/* The corner is the system's: the switcher, last so it stays over a stage that fills a phone. */}
      <Switcher ref={switcher} apps={apps} current={view} rest={shelf} still={still}
        hidden={(hidden && view === 'home') || lapsing}
        onOpen={id => openView(id as View)} />
    </div>
  );
}
