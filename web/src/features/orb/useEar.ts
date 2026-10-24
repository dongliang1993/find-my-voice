import { useCallback, useEffect, useRef, useState } from 'react';
import { microphone, type MicFailure } from '@/lib/microphone';

export type EarState = 'off' | 'listening' | 'hearing';
/** A tap ends on a pause or a second tap; a held Space ends only when it is let go. */
export type TalkMode = 'tap' | 'hold';
/** Why the last answer produced nothing: the microphone failed, or nothing was said. */
export type EarProblem = MicFailure | 'silent' | null;

/**
 * One spoken answer at a time, for whoever holds the circle. The microphone
 * is only open while a clip records, and a clip with no speech in it is never
 * sent — the transcription is where the cost is, not the open microphone.
 * `hear` gets the finished clip and decides what it means.
 */
export function useEar(hear: (audio: Blob, mime: string) => Promise<void>, { maxMs }: { maxMs?: number } = {}) {
  const [ear, setEar] = useState<EarState>('off');
  const [problem, setProblem] = useState<EarProblem>(null);
  /** The browser refused the microphone on this run, so it stops being offered. */
  const [denied, setDenied] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const hearRef = useRef(hear);
  hearRef.current = hear;

  // Never leave the microphone (and the system's recording indicator) on.
  useEffect(() => () => { abort.current?.abort(); microphone.close(); }, []);

  const start = useCallback(async (mode: TalkMode) => {
    if (abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    setProblem(null);
    setEar('listening');
    let clip: Awaited<ReturnType<typeof microphone.listen>>;
    try {
      clip = await microphone.listen({ signal: controller.signal, maxMs, endOnSilence: mode === 'tap' });
    } catch (error) {
      const reason = (error as { reason?: MicFailure }).reason ?? 'failed';
      if (reason === 'denied') setDenied(true);
      setProblem(reason);
      setEar('off');
      return;
    } finally {
      abort.current = null;
      microphone.close();
    }
    if (controller.signal.aborted) { setEar('off'); return; }
    if ('silent' in clip) { setProblem('silent'); setEar('off'); return; }
    setEar('hearing');
    try {
      await hearRef.current(clip.audio, clip.mime);
    } finally {
      setEar('off');
    }
  }, [maxMs]);

  /** Ends the answer and keeps it: a second tap, or Space let go. */
  const stop = useCallback(() => microphone.stop(), []);
  /** Throws the recording away: the user started typing instead. */
  const cancel = useCallback(() => abort.current?.abort(), []);

  return { ear, problem, denied, start, stop, cancel };
}
