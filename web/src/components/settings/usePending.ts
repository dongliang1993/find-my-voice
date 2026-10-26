import { useCallback, useEffect, useRef } from 'react';

type Pending = { timer?: ReturnType<typeof setTimeout>; run: () => void };

/**
 * Saves that wait — for a pause in typing, or for a field to be left — and
 * still happen if the sheet closes first. Each slot keeps only its latest
 * save; without `ms` it waits for `flush` (a key is saved whole, on blur).
 */
export function usePending() {
  const pending = useRef(new Map<string, Pending>());

  const flush = useCallback((slot?: string) => {
    for (const [key, entry] of [...pending.current]) {
      if (slot && key !== slot) continue;
      clearTimeout(entry.timer);
      pending.current.delete(key);
      entry.run();
    }
  }, []);

  const schedule = useCallback((slot: string, run: () => void, ms?: number) => {
    clearTimeout(pending.current.get(slot)?.timer);
    const timer = ms === undefined ? undefined : setTimeout(() => flush(slot), ms);
    pending.current.set(slot, { timer, run });
  }, [flush]);

  useEffect(() => () => flush(), [flush]);

  return { schedule, flush };
}
