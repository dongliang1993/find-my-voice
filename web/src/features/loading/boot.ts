import { create } from 'zustand';
import { audio } from '@/lib/audio';
import { FIXED, HINTS } from '@/features/onboarding/script';
import { useGlobal } from '@/store/global';

/** Even from a warm cache the line is seen to arrive, rather than flashing past. */
export const BOOT_MIN_MS = 600;
/** Past this, a quiet word under the line says it is the network, not a hang. */
export const BOOT_SLOW_MS = 7000;
/** A font that has not come in by now is let go: the fallback face is better than no screen. */
const FONT_CAP_MS = 10_000;

type Boot = {
  /** 0..1, how much of what has to be ready is ready. Never goes back. */
  reach: number;
  /** Everything worth waiting for is in, and the line has had its minimum. */
  done: boolean;
  slow: boolean;
  /** The line has breathed: the next screen takes over. */
  entered: boolean;
  enter: () => void;
};

export const useBoot = create<Boot>()(set => ({
  reach: 0, done: false, slow: false, entered: false,
  enter: () => set({ entered: true }),
}));

let started = false;

const capped = (work: Promise<unknown>, ms: number) =>
  Promise.race([work.catch(() => {}), new Promise(resolve => setTimeout(resolve, ms))]);

/** The faces she is written in, so no line of hers swaps its font after it appears. */
function fonts(): Promise<unknown> {
  if (!document.fonts) return Promise.resolve();
  const style = getComputedStyle(document.documentElement);
  const letter = style.getPropertyValue('--font-letter').trim();
  const sans = style.getPropertyValue('--font-sans').trim();
  const faces = [`400 22px ${letter}`, `italic 400 22px ${letter}`, `400 15px ${sans}`].filter(face => !face.endsWith('px '));
  return capped(Promise.all(faces.map(face => document.fonts.load(face))), FONT_CAP_MS);
}

/**
 * Loads what the first screen cannot do without and lets the rest follow.
 * Waited for: the status and the first-meeting record, the fonts, and — for a
 * first meeting — her first words and the lines she offers when someone
 * stalls, decoded, so Begin is answered at once. Everything else (the rest of
 * the meeting's lines, the interface sounds) loads behind the screen.
 * Every task counts once it settles, failed or not: an offline app is still
 * worth opening.
 */
export function startBoot() {
  if (started) return;
  started = true;
  const begun = performance.now();
  const wanted = [
    { id: 'onboarding-wake', key: 'wake' },
    { id: 'onboarding-ask_alias', key: 'ask_alias' },
    ...Object.values(HINTS).map(h => ({ id: `hint-${h.key}`, key: h.key })),
  ];
  // Counted from the start, so the line does not reach the end and then learn there was more.
  const total = 2 + wanted.length;
  let settled = 0;
  const tick = (count = 1) => {
    settled += count;
    useBoot.setState(state => ({ reach: Math.max(state.reach, settled / total) }));
  };
  const track = (work: Promise<unknown>) => work.catch(() => {}).then(() => tick());

  const slow = window.setTimeout(() => { if (!useBoot.getState().done) useBoot.setState({ slow: true }); }, BOOT_SLOW_MS);

  const ready = track(useGlobal.getState().checkReady());
  const faces = track(fonts());
  const voices = ready.then(() => {
    const first = useGlobal.getState().onboarding?.completedAt === null;
    if (!first) { tick(wanted.length); return; }
    return Promise.all(wanted.map(w => track(audio.prepare(w.id, `/onboarding/${w.key}.wav`))));
  });

  void Promise.all([ready, faces, voices])
    .then(() => new Promise(resolve => setTimeout(resolve, BOOT_MIN_MS - (performance.now() - begun))))
    .then(() => {
      window.clearTimeout(slow);
      useBoot.setState({ reach: 1, done: true, slow: false });
      background();
    });
}

/** Behind the screen: nothing here holds the first frame up. */
function background() {
  audio.warm();
  const first = useGlobal.getState().onboarding?.completedAt === null;
  if (first) for (const f of FIXED) void audio.prepare(`onboarding-${f.key}`, `/onboarding/${f.key}.wav`);
  else void audio.prepare(`hint-${HINTS.stage.key}`, `/onboarding/${HINTS.stage.key}.wav`);
}
