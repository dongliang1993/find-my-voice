import { Pause, Play } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { usePlaying } from '@/hooks/useVoice';
import { audio } from '@/lib/audio';

// Which papers have her reading, as the demo last said; outside a demo, none.
let letters: readonly string[] = [];
const listeners = new Set<() => void>();
export function setLetters(next: readonly string[]) {
  if (next.join('\n') === letters.join('\n')) return;
  letters = next;
  for (const listener of listeners) listener();
}
const useLetters = () => useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => letters);

/** Her reading of a letter, played through her own voice so she is seen saying it. */
export function ReadAloud({ paperId }: { paperId: string }) {
  const read = useLetters().includes(paperId);
  const id = `letter:${paperId}`;
  const playing = usePlaying() === id;
  if (!read) return null;
  const toggle = () => {
    if (playing) { audio.stopAll(); return; }
    audio.unlock();
    void audio.playClip(id, `/api/demo/letter/${encodeURIComponent(paperId)}`).catch(() => {});
  };
  return (
    <button type="button" onClick={toggle} aria-label={playing ? 'Stop' : 'Play'}
      className="ml-2 inline-grid size-6 place-items-center rounded-full align-middle text-(--paper-quiet) transition-colors hover:text-(--paper-ink) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--paper-quiet)/50">
      {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5 translate-x-px" />}
    </button>
  );
}
