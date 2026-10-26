import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Comfort, Rhythm } from '@shared/protocol';
import { Quiet } from '@/features/onboarding/answer';
import { ARRIVAL, Frame } from '@/features/onboarding/Frame';
import type { SpiralStage } from '@/components/Spiral';
import { ASKS, COMFORT_LABELS, HINTS, RHYTHM_LABELS, SCRIPT, type Ask } from '@/features/onboarding/script';
import { useOnboarding } from '@/features/onboarding/useOnboarding';
import { Orb } from '@/features/orb/Orb';
import { useEar, type EarProblem } from '@/features/orb/useEar';
import { useHint } from '@/features/orb/useHint';
import { api, type OnboardingState } from '@/lib/api';
import { microphone } from '@/lib/microphone';
import { cn } from '@/lib/utils';

type Props = { initial: OnboardingState; voiceReady: boolean; listenReady: boolean; onDone: () => void };
/** Where naming stands: asked, she is thinking, she proposed, or the user names her. */
type Naming = 'ask' | 'thinking' | 'proposed' | 'own';

const COMFORTS: { value: Comfort; label: string }[] = [
  { value: 'listen', label: COMFORT_LABELS.listen },
  { value: 'advise', label: COMFORT_LABELS.advise },
  { value: 'cheer', label: COMFORT_LABELS.cheer },
  { value: 'depends', label: COMFORT_LABELS.depends },
];
const RHYTHMS: { value: Rhythm; label: string }[] = [
  { value: 'morning', label: RHYTHM_LABELS.morning },
  { value: 'commute', label: RHYTHM_LABELS.commute },
  { value: 'night', label: RHYTHM_LABELS.night },
  { value: 'anytime', label: RHYTHM_LABELS.anytime },
];

/** How long a picked card stays lit, alone on the mat, before her turn takes the mat away. */
const PICK_MS = 300;
/** The beat she holds after saying your name back: the first thing she knows about you. */
const NAME_HOLD_MS = 700;

/** What she last said, for a reload that lands mid-way with nothing on screen. */
const RESUME: Record<Ask, string> = {
  alias: SCRIPT.askAlias, comfort: SCRIPT.comfortAsk, rhythm: SCRIPT.rhythmAsk,
  notes: SCRIPT.notesAsk, name: SCRIPT.nameAsk,
};

/** How long each question waits on someone before she offers a way in, and with what. */
const STUCK: Partial<Record<Ask, { ms: number; line: (typeof HINTS)[keyof typeof HINTS] }>> = {
  alias: { ms: 5000, line: HINTS.open },
  comfort: { ms: 8000, line: HINTS.choice },
  rhythm: { ms: 8000, line: HINTS.choice },
  notes: { ms: 10000, line: HINTS.notes },
};

/** Why a spoken answer did not land, in as few words as will do. */
const PROBLEM: Record<Exclude<EarProblem, null>, string> = {
  silent: "Didn't catch anything.",
  'no-device': 'No microphone found. Typing works too.',
  denied: "Can't reach the microphone. Typing works too.",
  unsupported: "Can't reach the microphone. Typing works too.",
  failed: "Can't reach the microphone. Typing works too.",
};

/**
 * First meeting, on the OS1 screen: her coil on a coral panel, her words
 * under it, your answer on the cream mat below. It opens like the film:
 * loading draws her line across, Begin comes up over it, and on the click
 * the line coils up into her and she speaks. The Begin click is also what
 * lets the browser play her voice.
 *
 * Open questions are answered at the circle, the same one the stage uses:
 * talk to it, or just start typing. Choices are picked and go on by
 * themselves. A restart picks up at the last saved step. It ends by turning
 * into the stage, so the one who asked is the one who is there.
 */
export function Onboarding({ initial, voiceReady, listenReady, onDone }: Props) {
  const { state, line, speak, replay, save, proposeName, finish } = useOnboarding(voiceReady, initial);
  const [alias, setAlias] = useState('');
  const [notes, setNotes] = useState('');
  const [comfort, setComfort] = useState<Comfort | null>(null);
  const [rhythm, setRhythm] = useState<Rhythm | null>(null);
  const [naming, setNaming] = useState<Naming>('ask');
  const [proposal, setProposal] = useState<{ name: string; reason: string } | null>(null);
  const [ownName, setOwnName] = useState('');
  /** An answer is on its way: the mat stays empty until her next line is done. */
  const [busy, setBusy] = useState(false);
  /** She is settling the names: the mat goes down for good, and the all-coral card is already the stage. */
  const [closing, setClosing] = useState(false);
  /** The meeting is over and the stage is coming in. */
  const [arriving, setArriving] = useState(false);
  /** Cuts the arrival short: a click anywhere during it. */
  const skip = useRef<(() => void) | null>(null);
  /** Asleep is her line lying under Begin, as loading left it; a reload past step 0 finds her already up. */
  const [phase, setPhase] = useState<SpiralStage>(initial.step > 0 ? 'awake' : 'asleep');
  /** Begin was pressed, so a second click does not start her twice. */
  const [begun, setBegun] = useState(false);
  /** What she made of a clip that held words but not the answer. */
  const [heardNote, setHeardNote] = useState('');
  /** She has started the question this step answers: the mat is on its way up. */
  const [rising, setRising] = useState(false);
  /** What the user just answered, kept on the mat while she takes it in. */
  const [said, setSaid] = useState<string | null>(null);

  const step = state?.step ?? 0;
  /** Which question this is, if it is one. */
  const ask: Ask | null = ASKS[step - 1] ?? null;

  /**
   * Whatever is said into the circle lands in the field, where it can be
   * checked before it is sent; nothing is committed by voice alone.
   */
  const hear = async (clip: Blob, mime: string) => {
    if (ask === 'alias') {
      const result = await api.hearAlias(clip, mime).catch(() => null);
      if (result?.alias) setAlias(result.alias);
      else setHeardNote(result?.said ? `Heard “${result.said}”, no name in it.` : "Didn't catch that.");
      return;
    }
    const result = await api.hear(clip, mime).catch(() => null);
    const text = result?.text.trim();
    if (!text) { setHeardNote("Didn't catch that."); return; }
    if (ask === 'notes') setNotes(text);
    else setOwnName(text.slice(0, 40));
  };
  const ear = useEar(hear);
  // A new question starts over: nothing left over from the last one.
  useEffect(() => { setHeardNote(''); }, [step, naming]);

  const begin = () => {
    if (begun) return;
    setBegun(true);
    answer(async () => {
      // The word goes, the line coils up into her, and her first words were decoded while loading, so they come at once.
      setPhase('awake');
      await save('alias', {});
      await speak(SCRIPT.wake);
      await speak(SCRIPT.askAlias);
    });
  };

  /** Whether the microphone is worth offering at all. */
  const canListen = listenReady && microphone.supported && !ear.denied;

  /** Runs one answer: hides the mat, lets her speak, brings the mat back. */
  const answer = (run: () => Promise<void>) => {
    setBusy(true);
    setRising(false);
    // Your words leave with her turn, so a later one never brings back an old answer.
    run().finally(() => { setBusy(false); setSaid(null); });
  };

  /** A name is settled, spoken or typed: she says it back and moves on. */
  const commitName = (name: string) => answer(async () => {
    setSaid(name);
    await save('comfort', { alias: name });
    await speak(SCRIPT.nameEcho(name));
    await new Promise(resolve => setTimeout(resolve, NAME_HOLD_MS));
    await speak(SCRIPT.comfortAsk);
  });

  /**
   * A picked card stays lit on the mat while the others go, so the pick is
   * seen; only then does her turn take the mat away.
   */
  const picking = useRef(false);
  const pick = <T,>(value: T, label: string, set: (value: T) => void, next: () => Promise<void>) => {
    if (busy || picking.current) return;
    picking.current = true;
    set(value);
    window.setTimeout(() => {
      setSaid(label);
      answer(async () => { picking.current = false; await next(); });
    }, PICK_MS);
  };

  const commitComfort = (value: Comfort) => pick(value, COMFORT_LABELS[value], setComfort, async () => {
    await save('rhythm', { comfort: value });
    await speak(SCRIPT.comfortEcho(COMFORT_LABELS[value]));
    await speak(SCRIPT.rhythmAsk);
  });

  const commitRhythm = (value: Rhythm) => pick(value, RHYTHM_LABELS[value], setRhythm, async () => {
    await save('notes', { rhythm: value });
    await speak(SCRIPT.rhythmEcho(RHYTHM_LABELS[value]));
    await speak(SCRIPT.notesAsk);
  });

  const commitNotes = (text: string) => answer(async () => {
    setSaid(text.trim() || null);
    await save('name', { notes: text });
    await speak(text.trim() ? SCRIPT.notesEcho : SCRIPT.nameAsk);
    if (text.trim()) await speak(SCRIPT.nameAsk);
    await speak(SCRIPT.nameHerself);
  });

  const askHerToName = () => answer(async () => {
    setNaming('thinking');
    // The server allows one proposal; null or a failure leaves naming to the user.
    const response = await proposeName(alias.trim(), notes.trim()).catch(() => null);
    if (response?.name) {
      setProposal({ name: response.name, reason: response.reason ?? '' });
      // Her suggestion goes straight into the field: from here it is a name to
      // edit, not a placeholder to type over.
      setOwnName(response.name);
      // Settled before she says it, so the mat comes up with her words rather than after them.
      setNaming('proposed');
      await speak(SCRIPT.proposeIntro);
    } else {
      setNaming('own');
      await speak(SCRIPT.proposeFallback);
    }
  });

  /** Waits out the arrival, or less if the user clicks through it. */
  const skippable = (ms: number) => new Promise<void>(resolve => {
    const timer = window.setTimeout(done, ms);
    skip.current = done;
    function done() { window.clearTimeout(timer); skip.current = null; resolve(); }
  });

  /**
   * The last step. She settles the names, the screen becomes the stage around
   * her, and once it has she says the first thing she says there — which has
   * to go out before the meeting is closed, as the server stops narrating
   * for the meeting after that.
   */
  const close = (companionName: string) => answer(async () => {
    const name = companionName.trim();
    if (!name) return;
    setClosing(true);
    ear.cancel();
    await speak(SCRIPT.finalEcho(alias.trim() || 'you', name));
    setArriving(true);
    await skippable(ARRIVAL.fadeMs + ARRIVAL.pauseMs + ARRIVAL.curtainMs);
    // Not awaited past the request: it plays on into the stage, as her first message there.
    await api.say(SCRIPT.arrival(alias.trim(), rhythm ?? 'anytime'), voiceReady).catch(() => null);
    await finish({
      alias: alias.trim() || 'you',
      companionName: name,
      nameOrigin: proposal?.reason || 'She picked her own name.',
      notes: notes.trim(),
      comfort: comfort ?? 'depends',
      rhythm: rhythm ?? 'anytime',
    });
    onDone();
  });

  /** Right-hand exit: whatever is left unanswered, she asks again another day. */
  const quit = () => {
    if (arriving) return;
    void close(ownName || proposal?.name || alias.trim() || 'you');
  };

  const speaking = Boolean(line?.speaking);
  /** The circle belongs to these steps: the ones answered in your own words. */
  const orbStep = ask === 'alias' || ask === 'notes' || (ask === 'name' && (naming === 'proposed' || naming === 'own'));
  const yourMove = phase === 'awake' && !speaking && !busy && !arriving;
  /**
   * She is asking the question your answer is for. The mat comes up as she
   * starts, so the answer is in place by the time she is done — shown, but
   * not taken until she has finished.
   */
  const question = ask === 'name'
    ? (naming === 'proposed' ? SCRIPT.proposeIntro : naming === 'own' ? SCRIPT.proposeFallback : SCRIPT.nameHerself)
    : ask ? RESUME[ask] : null;
  // Latched from the question's first word until an answer is given, so the
  // moment between her last word and her turn ending never drops the mat.
  if (speaking && line?.text === question && !rising) setRising(true);
  /** The mat is up: your turn, or the question for it under way. */
  const matUp = phase === 'awake' && !closing && !arriving && (yourMove || rising);
  /** What is in the circle's field on this step. */
  const value = ask === 'alias' ? alias : ask === 'notes' ? notes : ownName;
  const stuck = ask ? STUCK[ask] : undefined;
  const aside = useHint(stuck && yourMove && ear.ear === 'off' && !value.trim() ? ask : null, stuck?.ms ?? 0, stuck?.line ?? HINTS.open);

  const companionName = ownName.trim() || proposal?.name || '';

  const panelLine = aside
    ?? (naming === 'proposed' && proposal && !speaking
      ? `I'd like to be called “${proposal.name}”.`
      : line?.text ?? (ask ? RESUME[ask] : ''));

  // While she settles the names the circle stays (dimmed) where the stage will pick it up.
  const orbShown = phase === 'awake' && orbStep && (matUp || arriving);
  const send = (text: string) => {
    if (ask === 'alias') commitName(text);
    else if (ask === 'notes') commitNotes(text);
    else void close(text);
  };
  const orb = (
    <Orb key={`${ask}-${naming}`} ear={ear.ear} canSpeak={canListen} disabled={!orbShown || !yourMove}
      // Full size through the arrival, as the stage puts it down at full size.
      dim={!arriving && !orbShown}
      autoOpen={ask === 'name' && naming === 'own' && yourMove}
      value={value} onChange={ask === 'alias' ? setAlias : ask === 'notes' ? setNotes : setOwnName}
      onSend={send} onStart={mode => { setHeardNote(''); void ear.start(mode); }} onStop={ear.stop} onCancel={ear.cancel}
      label={ask === 'alias' ? 'Your name' : ask === 'notes' ? 'On your mind' : 'Her name'}
      maxLength={ask === 'notes' ? 400 : 40} />
  );
  const note = heardNote || (ear.problem ? PROBLEM[ear.problem] : '');
  const under = !yourMove ? null
    : note ? <p aria-live="polite" className="text-[12px] text-muted-foreground">{note}</p>
      : ask === 'notes' ? <Skip onClick={() => { setNotes(''); commitNotes(''); }} /> : null;

  let belowKey: string | null = null;
  let below: ReactNode = null;
  if (matUp) {
    // Up with her question, but nothing is taken before she has finished it.
    if (ask === 'comfort') {
      belowKey = 'comfort';
      below = <Choices options={COMFORTS} value={comfort} onPick={commitComfort} label="How to meet a bad day" />;
    } else if (ask === 'rhythm') {
      belowKey = 'rhythm';
      below = <Choices options={RHYTHMS} value={rhythm} onPick={commitRhythm} label="When you want to talk" />;
    } else if (ask === 'name' && naming === 'ask') {
      belowKey = 'naming';
      below = (
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          <button type="button" onClick={askHerToName}
            className="h-10 rounded-full bg-primary px-6 text-[15px] text-primary-foreground transition-colors hover:bg-primary/90">
            Have her pick
          </button>
          <Quiet onClick={() => setNaming('own')}>I'll pick</Quiet>
        </div>
      );
    }
  }

  const offered = below && <div inert={!yourMove} className="contents">{below}</div>;

  return (
    <Frame
      thinking={naming === 'thinking'}
      line={phase !== 'awake' ? '' : panelLine}
      mark={said && line?.text === SCRIPT.nameEcho(said) ? said : null}
      herTurn={phase === 'awake' && !matUp}
      below={offered}
      belowKey={belowKey}
      orb={orb}
      orbShown={orbShown}
      under={under}
      stage={phase}
      ask={phase === 'awake' && ask ? { index: step, total: ASKS.length } : null}
      onBegin={phase === 'asleep' && !begun ? begin : null}
      onReplay={line?.missed && !arriving ? () => { replay(); } : null}
      onQuit={phase === 'awake' ? quit : null}
      listening={ear.ear !== 'off'}
      said={(speaking || busy) && !arriving ? said : null}
      arriving={arriving}
      onSkip={() => skip.current?.()}
    />
  );
}

/** The way past a question: a line of text, not a button, so nothing competes with the circle. */
function Skip({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="rounded-full px-2 text-[13px] text-muted-foreground/80 underline-offset-4 transition-colors hover:text-foreground hover:underline">
      Skip
    </button>
  );
}

/**
 * A choice question: cards, no field. Picking one confirms it — there is no
 * separate button. The pick stays where it is and the rest fade, so it reads
 * as an answer rather than a form being submitted.
 */
function Choices<T extends string>({ options, value, onPick, label }: {
  options: { value: T; label: string }[]; value: T | null; onPick: (value: T) => void; label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid w-full gap-2 sm:grid-cols-2">
      {options.map(option => (
        <button key={option.value} type="button" role="radio" aria-checked={value === option.value}
          onClick={() => onPick(option.value)} disabled={value !== null}
          className={cn('h-12 rounded-xl border text-[15px] transition-[color,background-color,border-color,opacity] duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
            value === option.value
              ? 'border-primary/30 bg-primary/10 text-primary'
              : cn('border-foreground/15 bg-(--field) text-foreground shadow-[0_1px_2px_color-mix(in_srgb,var(--foreground)_6%,transparent)]',
                value === null ? 'hover:border-primary/40 hover:bg-primary/5' : 'opacity-0'))}>
          {option.label}
        </button>
      ))}
    </div>
  );
}
