import { useLayoutEffect, useRef, type RefObject } from 'react';
import { holdDark } from '@/lib/theme';

export type Mood = 'calm' | 'happy' | 'longing' | 'low';

interface Keyframe { hour: number; her: string; base: string }

/**
 * The light through the day. Night is nearly brown, afternoon is the coral's
 * most saturated, and the two are far enough apart that the change is felt
 * rather than noticed. Dusk goes down through peach and terracotta: straight
 * from cream to brown, the room passed through grey around seven.
 *
 * index.html repeats where the room crosses into dark (19:40 to 3:24) for the
 * first paint; moving a base stop moves those times.
 */
const KEYFRAMES: Keyframe[] = [
  { hour: 1, her: '#7A3A33', base: '#1F1513' },
  { hour: 6, her: '#D9644A', base: '#F7EEE6' },
  { hour: 11, her: '#D2513F', base: '#F5ECE3' },
  { hour: 17.5, her: '#D9493A', base: '#F6E6DA' },
  { hour: 19, her: '#D44A38', base: '#F0C9A6' },
  { hour: 20, her: '#B4473A', base: '#A85A40' },
  { hour: 21, her: '#9E4136', base: '#2B1D1A' },
];

/** Mood shifts the coral on the HSL wheel: hue°, saturation%, lightness%. */
const MOOD_SHIFT: Record<Mood, [number, number, number]> = {
  calm: [0, 0, 0],
  happy: [8, 6, 3],
  longing: [-6, -18, -6],
  low: [-4, -25, -8],
};

const INK_LIGHT = '#3A2622';
const INK_DARK = '#F5E6DC';

type RGB = [number, number, number];

const hexToRgb = (hex: string): RGB => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgbToHex = ([r, g, b]: RGB) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function rgbToHsl([r, g, b]: RGB): RGB {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}

function hslToRgb([h, s, l]: RGB): RGB {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** An S-curve: flat at both ends, fast through the middle, 0→0 and 1→1. */
const steep = (t: number) => {
  const s = (x: number) => 1 / (1 + Math.exp(-14 * (x - 0.5)));
  return (s(t) - s(0)) / (s(1) - s(0));
};

const luminance = ([r, g, b]: RGB) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** The two colours for this moment, interpolated between neighbouring stops. */
export function colorsAt(date: Date): { her: RGB; base: RGB } {
  const h = date.getHours() + date.getMinutes() / 60;
  const n = KEYFRAMES.length;
  for (let i = 0; i < n; i++) {
    const a = KEYFRAMES[i]!;
    const b = KEYFRAMES[(i + 1) % n]!;
    const start = a.hour;
    const end = b.hour > a.hour ? b.hour : b.hour + 24;
    const cur = h < start ? h + 24 : h;
    if (cur >= start && cur < end) {
      const t = (cur - start) / (end - start);
      // The page colour crosses light/dark on a steep curve, so it does not sit grey for hours.
      return { her: mix(hexToRgb(a.her), hexToRgb(b.her), t), base: mix(hexToRgb(a.base), hexToRgb(b.base), steep(t)) };
    }
  }
  return { her: hexToRgb(KEYFRAMES[0]!.her), base: hexToRgb(KEYFRAMES[0]!.base) };
}

export function applyMood(her: RGB, mood: Mood): RGB {
  const [dh, ds, dl] = MOOD_SHIFT[mood];
  const [h, s, l] = rgbToHsl(her);
  return hslToRgb([h + dh, Math.max(0, Math.min(100, s + ds)), Math.max(0, Math.min(100, l + dl))]);
}

/**
 * Writes the ambient palette onto an element: `--her` (the coral), `--base`
 * (the page) and `--ink`, plus `data-dark`. Re-read every minute; the CSS
 * transition is what makes a change of hour or mood a slow fade rather than a
 * step. Written before paint, so the first frame is already in the right light.
 *
 * `now` pins the clock for previewing a time of day. `page` makes the whole
 * page follow the hour too, not only the element: the theme's light or dark
 * tokens then come from the clock instead of the system, for as long as the
 * element is up.
 */
export function useAmbientTheme(target: RefObject<HTMLElement | null>, mood: Mood, { now, page = false }: { now?: Date; page?: boolean } = {}) {
  const moodRef = useRef(mood);
  moodRef.current = mood;

  useLayoutEffect(() => {
    const el = target.current;
    if (!el) return;
    const hold = page ? holdDark() : null;
    const apply = () => {
      const { her, base } = colorsAt(now ?? new Date());
      const dark = luminance(base) < 0.45;
      el.style.setProperty('--her', rgbToHex(applyMood(her, moodRef.current)));
      el.style.setProperty('--base', rgbToHex(base));
      el.style.setProperty('--ink', dark ? INK_DARK : INK_LIGHT);
      el.dataset.dark = dark ? 'true' : 'false';
      hold?.set(dark);
    };
    apply();
    const id = now ? undefined : window.setInterval(apply, 60_000);
    return () => { window.clearInterval(id); hold?.release(); };
  }, [target, mood, now, page]);
}
