import { useEffect } from 'react';
import type { DemoAction, DemoCue } from '@shared/protocol';
import type { DemoState } from '@/hooks/useChat';
import { setLetters } from '@/features/demo/ReadAloud';

/** → during the first meeting: the page plays that part itself, so the key stays on the page. */
export const MEETING_NEXT = 'fmv-demo-meeting-next';
const CURSOR_IDLE_MS = 1500;

/**
 * The recording's keys, only while the server plays a demo: → on, ← back a
 * step, ⌥R the scene again, ⌥1–⌥9 a scene. Taken in the capture phase, so the
 * circle never reads them as typing. Nothing is drawn for any of it.
 */
export function useDemo(demo: DemoState | null, cue: { seq: number; cue: DemoCue } | null, act: (action: DemoAction, scene?: number) => void,
  { meeting = false }: { meeting?: boolean } = {}) {
  const on = demo !== null;

  useEffect(() => {
    if (!on) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Words in a field are being typed; its arrows move the caret. In the first meeting the field only ever holds the answer → gives.
      if (target?.closest('textarea, [contenteditable="true"]') || (!meeting && target instanceof HTMLInputElement && target.value)) return;
      const plain = !event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey;
      const action: [DemoAction, number?] | null =
        plain && event.key === 'ArrowRight' ? ['next']
          : plain && event.key === 'ArrowLeft' ? ['back']
            : event.altKey && event.code === 'KeyR' ? ['reset']
              : event.altKey && /^Digit[1-9]$/.test(event.code) ? ['jump', Number(event.code.slice(5))]
                : null;
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (meeting && action[0] === 'next') window.dispatchEvent(new Event(MEETING_NEXT));
      else if (!meeting || action[0] !== 'back') act(...action);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [on, act, meeting]);

  // A scene set up again, or the app opened anew: the page starts over from what the server has now.
  useEffect(() => { if (cue?.cue.type === 'reload') location.reload(); }, [cue?.seq]);

  useEffect(() => { setLetters(demo?.letters ?? []); }, [demo?.letters]);

  // Gone only while it sits still: out of the shot, yet there the moment a click is needed.
  const hideCursor = Boolean(demo?.hideCursor);
  useEffect(() => {
    if (!hideCursor) return;
    const root = document.documentElement;
    let timer = window.setTimeout(() => root.setAttribute('data-demo-cursor', ''), CURSOR_IDLE_MS);
    const onMove = () => {
      root.removeAttribute('data-demo-cursor');
      window.clearTimeout(timer);
      timer = window.setTimeout(() => root.setAttribute('data-demo-cursor', ''), CURSOR_IDLE_MS);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerdown', onMove);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onMove);
      root.removeAttribute('data-demo-cursor');
    };
  }, [hideCursor]);
}
