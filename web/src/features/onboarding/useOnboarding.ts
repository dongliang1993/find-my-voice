import { useCallback, useState } from 'react';
import { api, type OnboardingState } from '@/lib/api';
import { audio } from '@/lib/audio';
import { FIXED, stepOf, type Ask } from '@/features/onboarding/script';

/**
 * The onboarding driver. One rule carries the whole design: a step advances
 * only after its draft reached the server, so a closed tab loses at most the
 * line currently on screen — never a completed step.
 *
 * The scripted lines are fixed text in script.ts; the model is never in the
 * loop during onboarding.
 */

/** `locked`: the browser refused sound before any click or keypress. */
type Played = 'played' | 'locked' | 'failed';

/**
 * Plays an archive to the end. Goes through the shared engine so her coil
 * and the progress line can follow it. Never throws: a line that cannot be
 * heard is still read, and onboarding goes on.
 */
async function playArchive(id: string, url: string): Promise<Played> {
  try {
    const { ended } = await audio.playClip(id, url);
    await ended;
    return 'played';
  } catch {
    return audio.unlocked ? 'failed' : 'locked';
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** How long a line stays when it is only read, so lines in a row do not flash past. */
const readingMs = (text: string) => Math.min(4000, 900 + text.length * 110);

/** Resolves once nothing with this id is audible any more. */
function untilSilent(id: string): Promise<void> {
  return new Promise(resolve => {
    if (audio.playing !== id) { resolve(); return; }
    const stop = audio.subscribe(() => { if (audio.playing !== id) { stop(); resolve(); } });
  });
}

export type SpeakOptions = { speak?: boolean };
/**
 * The line on screen. `clip` is set while an archive plays, so its length is
 * known. `missed` holds the archive of a line the browser would not let her
 * say out loud, for replaying on a click.
 */
export type Line = { text: string; speaking: boolean; clip: string | null; missed: string | null };

/** `initial` is the record loading already fetched, so the meeting is on screen the moment loading hands over. */
export function useOnboarding(voiceReady: boolean, initial: OnboardingState) {
  const [state, setState] = useState<OnboardingState>(initial);
  const [line, setLine] = useState<Line | null>(null);

  /** A scripted line: shown as text, spoken when a voice is ready. Resolves when the line is done. */
  const speak = useCallback(async (text: string, { speak = true }: SpeakOptions = {}) => {
    const spoken = speak && voiceReady;
    // Pre-generated with the configured voice; a hit never calls the API.
    const fixed = FIXED.find(f => f.text === text);
    if (spoken && fixed) {
      const clip = `onboarding-${fixed.key}`;
      const url = `/onboarding/${fixed.key}.wav`;
      setLine({ text, speaking: true, clip, missed: null });
      const played = await playArchive(clip, url);
      if (played !== 'played') await sleep(readingMs(text));
      setLine({ text, speaking: false, clip: null, missed: played === 'locked' ? url : null });
      return;
    }
    const { audioId } = await api.say(text, spoken);
    if (!audioId) {
      setLine({ text, speaking: false, clip: null, missed: null });
      await sleep(readingMs(text));
      return;
    }
    setLine({ text, speaking: true, clip: null, missed: null });
    // The line is being synthesized and archived server-side; poll until the
    // archived audio exists, which is exactly when the server finished it.
    await new Promise<void>(resolve => {
      const timer = window.setInterval(() => {
        void api.audioReady(audioId)
          .then(ready => { if (ready) { window.clearInterval(timer); resolve(); } })
          .catch(() => { });
      }, 1000);
    });
    // Synthesis outruns playback: the archive exists before she has finished saying it.
    await untilSilent(audioId);
    // A locked browser dropped the streamed chunks; the archive is there to replay.
    setLine({ text, speaking: false, clip: null, missed: audio.unlocked ? null : api.audioUrl(audioId) });
  }, [voiceReady]);

  /** Says the line on screen again, from its archive. Called from a click, so the browser allows sound. */
  const replay = useCallback(async () => {
    if (!line?.missed) return;
    const { text, missed } = line;
    const clip = `replay-${missed}`;
    setLine({ text, speaking: true, clip, missed: null });
    const played = await playArchive(clip, missed);
    setLine({ text, speaking: false, clip: null, missed: played === 'played' ? null : missed });
  }, [line]);

  /** A question's draft reaches the server before the question is considered reached. */
  const save = useCallback(async (ask: Ask, draft: Record<string, unknown>) => {
    setState(await api.saveOnboarding(stepOf(ask), draft, false));
  }, []);

  /** One name proposal from the model, with the server-side retry limit. */
  const proposeName = useCallback(async (alias: string, notes: string) => api.proposeName(alias, notes), []);

  /** The last call: names, the answers, and onboarding closed for good. */
  const finish = useCallback(async (final: Parameters<typeof api.finishOnboarding>[0]) => {
    await api.finishOnboarding(final);
  }, []);

  return { state, line, speak, replay, save, proposeName, finish };
}
