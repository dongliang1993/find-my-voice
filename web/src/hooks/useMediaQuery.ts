import { useSyncExternalStore } from 'react';

/** True when the viewport matches the query; re-renders on change. */
export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    onChange => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
  );
}
