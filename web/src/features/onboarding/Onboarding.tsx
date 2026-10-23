import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Comfort, Rhythm } from '@shared/protocol';
import { Answer, AnswerField, AnswerInput, Quiet, Skip, Submit } from '@/features/onboarding/answer';
import { MicButton, type EarState } from '@/features/onboarding/mic';
import { Frame } from '@/features/onboarding/Frame';
import { type ProgressMode } from '@/features/onboarding/progress';
import { UNFOLD_MS, type SpiralStage } from '@/components/Spiral';
import { ASKS, COMFORT_LABELS, RHYTHM_LABELS, SCRIPT, type Ask } from '@/features/onboarding/script';
import { useOnboarding } from '@/features/onboarding/useOnboarding';
import { api } from '@/lib/api';
import { microphone } from '@/lib/microphone';
import { cn } from '@/lib/utils';

type Props = { voiceReady: boolean; listenReady: boolean; onDone: () => void };
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

/** How long a picked card stays lit before the next question. */
const PICK_MS = 500;
const LEAVE_MS = 700;

/**
 * First meeting, on the OS1 screen: her coil on a coral panel, her words
 * under it, your answer on the cream mat below. It opens like the film:
 * Begin, a line drawing itself across, that line coiling up into her, her
 * first words. The Begin click is also what lets the browser play her voice.
 *
 * Two kinds of question, one rule: open ones are spoken or typed into the
 * same field and confirmed, choices are picked and go on by themselves. No
 * step buttons; each beat passes through towards you. A restart picks up at
 * the last saved step. Always the Her look, whatever the chat later uses.
 */
export function Onboarding({ voiceReady, listenReady, onDone }: Props) {
  const { state, line, bootProgress, speak, replay, save, proposeName, finish } = useOnboarding(voiceReady);
  const [alias, setAlias] = useState('');
  const [notes, setNotes] = useState('');
  const [comfort, setComfort] = useState<Comfort | null>(null);
  const [rhythm, setRhythm] = useState<Rhythm | null>(null);
  const [naming, setNaming] = useState<Naming>('ask');
  const [proposal, setProposal] = useState<{ name: string; reason: string } | null>(null);
  const [ownName, setOwnName] = useState('');
  /** An answer is on its way: the mat stays empty until her next line is done. */
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  /** null until the saved step is known; asleep waits for Begin; drawing is the install line; awake once she is up. */
  const [phase, setPhase] = useState<SpiralStage | null>(null);
  /** Begin was pressed: it fades out first, and only then does her line start drawing. */
  const [begun, setBegun] = useState(false);
  const [ear, setEar] = useState<EarState>('off');
  /** Aborts the recording in progress: the user chose to type, or the page went away. */
  const earAbort = useRef<AbortController | null>(null);
  /** The browser refused the microphone on this run, so the button stops offering it. */
  const [micDenied, setMicDenied] = useState(false);
  /** A hint under the field after a spoken answer did not land. */
  const [earNote, setEarNote] = useState('');
  /** What the user just answered, kept on the mat while she takes it in. */
  const [said, setSaid] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  // A new open question starts over: no leftover hint from the last one.
  useEffect(() => { setEarNote(''); }, [state?.step]);

  // Never leave the microphone (and the system's recording indicator) on.
  useEffect(() => () => { earAbort.current?.abort(); microphone.close(); }, []);

  // A reload past step 0 skips the opening: she is already up. A fresh
  // visit boots first: the bar fills, reaches 100%, goes away — and only
  // then does Begin appear.
  const booted = bootProgress >= 1;
  useEffect(() => {
    if (!state) return;
    if (state.step > 0) { if (phase === null) setPhase('awake'); return; }
    if (booted && phase === null) setPhase('asleep');
  }, [state, phase, booted]);

  const begin = () => {
    if (begun) return;
    setBegun(true);
    answer(async () => {
      // The word stretches out into her line first; only then does it coil up.
      setPhase('drawing');
      await new Promise(resolve => setTimeout(resolve, UNFOLD_MS));
      setPhase('awake');
      await save('alias', {});
      await speak(SCRIPT.wake);
      // Nothing is opened here: the stream is held only while a clip records.
      await speak(SCRIPT.askAlias);
    });
  };

  /** Whether the microphone is worth offering at all. */
  const canListen = listenReady && microphone.supported && !micDenied;

  /** Runs one answer: hides the mat, lets her speak, brings the mat back. */
  const answer = (run: () => Promise<void>) => {
    setBusy(true);
    run().finally(() => setBusy(false));
  };

  /**
   * One spoken answer into whichever field is open. What she makes out lands
   * in the field, where the user sees it and may correct it before sending;
   * nothing is committed by voice alone.
   */
  const listen = async (onHeard: (text: string) => void) => {
    const controller = new AbortController();
    earAbort.current = controller;
    setEarNote('');
    setEar('listening');
    let clip: Awaited<ReturnType<typeof microphone.listen>>;
    try {
      clip = await microphone.listen({ signal: controller.signal });
    } catch (error) {
      setEar('off');
      // A refused permission is worth remembering: stop offering the button.
      if ((error as { reason?: string }).reason === 'denied') setMicDenied(true);
      setEarNote((error as { reason?: string }).reason === 'no-device' ? 'No microphone found — typing works too.' : "Can't reach the microphone — typing works too.");
      return;
    } finally {
      // The stream is only held for the clip: the tab stops showing the recording dot.
      microphone.close();
    }
    if (controller.signal.aborted) { setEar('off'); return; }
    if ('silent' in clip) { setEar('off'); setEarNote("Didn't catch anything — you can type too."); return; }
    setEar('hearing');
    const result = await api.hearAlias(clip.audio, clip.mime).catch(() => null);
    setEar('off');
    if (result?.alias) onHeard(result.alias);
    else setEarNote(result?.said ? `Heard “${result.said}”, no name in it.` : "Didn't catch that — typing works too.");
  };

  /** Throws the recording away: the user would rather type. */
  const stopListening = () => earAbort.current?.abort();
  /** Ends the answer but keeps it: the second tap on the button, or a released Space. */
  const finishSpeaking = () => microphone.stop();

  /** A name is settled, spoken or typed: she says it back and moves on. */
  const commitName = (name: string) => answer(async () => {
    stopListening();
    setSaid(name);
    await save('comfort', { alias: name });
    await speak(SCRIPT.nameEcho(name));
    await speak(SCRIPT.comfortAsk);
  });

  /** A picked card stays lit for a moment — and stays on the mat — then the next question comes. */
  const pick = <T,>(value: T, label: string, set: (value: T) => void, next: () => Promise<void>) => {
    if (busy) return;
    set(value);
    setSaid(label);
    answer(async () => {
      await new Promise(resolve => setTimeout(resolve, PICK_MS));
      await next();
    });
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
      await speak(SCRIPT.proposeIntro);
      setNaming('proposed');
    } else {
      await speak(SCRIPT.proposeFallback);
      setNaming('own');
    }
  });

  /** The last step: everything lands at once, and the panel dissolves into the chat. */
  const close = (companionName: string) => answer(async () => {
    const name = companionName.trim();
    if (!name) return;
    await speak(SCRIPT.finalEcho(alias.trim() || 'you', name));
    await finish({
      alias: alias.trim() || 'you',
      companionName: name,
      nameOrigin: proposal?.reason || 'She picked her own name.',
      notes: notes.trim(),
      comfort: comfort ?? 'depends',
      rhythm: rhythm ?? 'anytime',
    });
    setLeaving(true);
    await new Promise(resolve => setTimeout(resolve, LEAVE_MS));
    onDone();
  });

  /** Right-hand exit: whatever is left unanswered, she asks again another day. */
  const quit = () => {
    if (leaving) return;
    stopListening();
    void close(ownName || proposal?.name || alias.trim() || 'you');
  };

  if (!state) return null;
  const step = state.step;
  const companionName = ownName.trim() || proposal?.name || '';

  const speaking = Boolean(line?.speaking);
  // Before she is up, the line is Spiral's own (and before Begin there is none yet),
  // so this bar stays out of the way entirely.
  const progress: ProgressMode = phase === null && !booted ? 'boot'
    : phase !== 'awake' ? 'empty'
      : ear === 'hearing' ? 'flow'
        : naming === 'thinking' && !speaking ? 'flow'
          : speaking ? (line?.clip ? 'clip' : 'flow')
            : line ? 'rest' : 'empty';

  /** Which question this is, if it is one. */
  const ask: Ask | null = ASKS[step - 1] ?? null;
  /** What she last said, for a reload that lands mid-way with nothing on screen. */
  const RESUME: Record<Ask, string> = {
    alias: SCRIPT.askAlias, comfort: SCRIPT.comfortAsk, rhythm: SCRIPT.rhythmAsk,
    notes: SCRIPT.notesAsk, name: SCRIPT.nameAsk,
  };
  const panelLine = naming === 'proposed' && proposal && !speaking
    ? `I'd like to be called “${proposal.name}”.`
    : line?.text ?? (ask ? RESUME[ask] : '');


  /**
   * An open question: she is listening, so the microphone leads, the field is
   * the fallback under it, and the way past is a line of text at the bottom.
   */
  const openAsk = (value: string, onChange: (value: string) => void, hint: string, label: string, submit: () => void, skip?: () => void) => (
    <Answer onSubmit={() => { if (value.trim()) submit(); }}>
      <MicButton ear={ear} canSpeak={canListen} onStart={() => { void listen(onChange); }} onStop={finishSpeaking} />
      {/* Reserved one line tall and empty at rest, so starting to listen never
          moves the field; the words only appear when there is something to say. */}
      <p aria-live="polite" className="h-4 text-[11px] leading-4 text-muted-foreground/70">
        {ear === 'listening' ? 'I am listening…' : ear === 'hearing' ? 'Working it out…' : ''}
      </p>
      <AnswerField inputRef={field} value={value} ready={Boolean(value.trim())} label={label} autoFocus={!canListen}
        placeholder={!canListen ? '' : earNote || hint}
        onChange={text => { onChange(text); if (ear !== 'off') stopListening(); }} />
      {skip && <Skip onClick={skip}>Skip</Skip>}
    </Answer>
  );

  let belowKey: string | null = null;
  let below: ReactNode = null;
  if (!speaking && !busy && !leaving) {
    if (ask === 'alias') {
      belowKey = 'alias';
      below = openAsk(alias, setAlias, 'What should I call you?', 'your name', () => commitName(alias.trim()));
    } else if (ask === 'comfort') {
      belowKey = 'comfort';
      below = <Choices options={COMFORTS} value={comfort} onPick={commitComfort} label="How to meet a bad day" />;
    } else if (ask === 'rhythm') {
      belowKey = 'rhythm';
      below = <Choices options={RHYTHMS} value={rhythm} onPick={commitRhythm} label="When you want to talk" />;
    } else if (ask === 'notes') {
      belowKey = 'notes';
      below = openAsk(notes, setNotes, 'Tell her…', 'On your mind',
        () => commitNotes(notes.trim()), () => { setNotes(''); commitNotes(''); });
    } else if (ask === 'name') {
      if (naming === 'ask') {
        belowKey = 'naming';
        below = (
          <Center>
            <button type="button" onClick={askHerToName}
              className="h-10 rounded-full bg-primary px-6 text-[15px] text-primary-foreground transition-colors hover:bg-primary/90">
              Have her pick
            </button>
            <Quiet onClick={() => setNaming('own')}>I'll pick</Quiet>
          </Center>
        );
      } else if (naming === 'thinking') {
        belowKey = 'thinking';
        below = null;
      } else {
        belowKey = `name-${naming}`;
        below = (
          <Answer onSubmit={() => { if (companionName) void close(companionName); }}>
            <AnswerInput autoFocus value={ownName} maxLength={40} aria-label="Her name"
              placeholder="Her name" onChange={e => setOwnName(e.target.value)} />
            <Submit ready={Boolean(companionName)}>Call her that</Submit>
          </Answer>
        );
      }
    }
  }

  return (
    <Frame
      thinking={naming === 'thinking'}
      progress={progress}
      boot={bootProgress}
      clip={line?.clip ?? null}
      line={leaving || phase !== 'awake' ? '' : panelLine}
      below={below}
      belowKey={belowKey}
      stage={phase ?? 'asleep'}
      ask={phase === 'awake' && !leaving && ask ? { index: step, total: ASKS.length } : null}
      onBegin={phase === 'asleep' && !begun ? begin : null}
      onReplay={line?.missed && !leaving ? () => { replay(); } : null}
      onQuit={phase === 'awake' && !leaving ? quit : null}
      listening={ear !== 'off'}
      said={speaking || busy ? said : null}
      leaving={leaving}
    />
  );
}

/**
 * A choice question: cards, no field. Picking one confirms it — there is no
 * separate button, and the highlight holds for a beat so the pick is seen.
 */
function Choices<T extends string>({ options, value, onPick, label }: {
  options: { value: T; label: string }[]; value: T | null; onPick: (value: T) => void; label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid w-full gap-2 sm:grid-cols-2">
      {options.map(option => (
        <button key={option.value} type="button" role="radio" aria-checked={value === option.value}
          onClick={() => onPick(option.value)}
          className={cn('h-12 rounded-xl border text-[15px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
            value === option.value
              ? 'border-primary bg-primary/8 text-primary'
              : 'border-(--field-edge)/60 bg-(--field) text-foreground hover:border-(--field-edge)')}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Center({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-center gap-2 pt-1">{children}</div>;
}
