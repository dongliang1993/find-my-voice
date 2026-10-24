import { useSyncExternalStore } from 'react';

/**
 * Two looks for the same app. `radio` is the night console, always dark.
 * `her` is warm afternoon light that turns to lamplight when the system goes dark.
 * The choice is a per-browser convenience, so it lives in localStorage;
 * index.html applies it before first paint with the same rules as here.
 */
export type ThemeName = 'radio' | 'her';
export const THEMES: readonly ThemeName[] = ['radio', 'her'];

const KEY = 'fmv-theme';
// Her, because the first meeting is OS1 and the chat should look like where it began.
const DEFAULT_THEME: ThemeName = 'her';
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

type Snapshot = { theme: ThemeName; dark: boolean };

function stored(): ThemeName | null {
  try {
    const value = localStorage.getItem(KEY);
    return THEMES.includes(value as ThemeName) ? (value as ThemeName) : null;
  } catch {
    return null;
  }
}

/** A screen that must look one way whatever was chosen (onboarding is always OS1). */
let forced: ThemeName | null = null;
let chosen = stored();

/** Screens that take their light from the hour instead of the system; the latest one up decides. */
const holds: { dark: boolean }[] = [];

const resolve = (): Snapshot => {
  const theme = forced ?? chosen ?? DEFAULT_THEME;
  return { theme, dark: theme === 'radio' || (holds.at(-1)?.dark ?? systemDark.matches) };
};

let snapshot = resolve();
const listeners = new Set<() => void>();

function apply() {
  const root = document.documentElement;
  root.dataset.theme = snapshot.theme;
  root.classList.toggle('dark', snapshot.dark);
  root.style.colorScheme = snapshot.dark ? 'dark' : 'light';
  const page = getComputedStyle(root).getPropertyValue('--page').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', page || '#000000');
}

function update(next: Snapshot) {
  if (next.theme === snapshot.theme && next.dark === snapshot.dark) return;
  snapshot = next;
  apply();
  for (const listener of listeners) listener();
}

systemDark.addEventListener('change', () => update(resolve()));
apply();

export function setTheme(theme: ThemeName) {
  try { localStorage.setItem(KEY, theme); } catch { /* private mode: the choice lasts this visit */ }
  chosen = theme;
  update(resolve());
}

/** Shows `theme` regardless of the saved choice until called again with null. */
export function forceTheme(theme: ThemeName | null) {
  forced = theme;
  update(resolve());
}

/**
 * Lets a screen decide light or dark for the whole page while it is up — the
 * first meeting and the loading gate follow her hour, not the system. `radio`
 * stays dark whatever is held.
 */
export function holdDark() {
  const hold = { dark: snapshot.dark };
  holds.push(hold);
  return {
    set(dark: boolean) { hold.dark = dark; update(resolve()); },
    release() { holds.splice(holds.indexOf(hold), 1); update(resolve()); },
  };
}

export function useTheme(): Snapshot {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => snapshot);
}
