// A day of her light in a few seconds, for recording. The room's colours come
// from the hour alone, so running the hour forward is the whole of it. Pure,
// so the clock is testable; the page drives it a frame at a time.
//
//   ?timelapse=06:00-23:40&seconds=10     then ⌥⇧T to run, Esc to stop

/** Minutes past midnight to start and end at (an end before the start runs past midnight), and how long it takes. */
export type Lapse = { from: number; to: number; ms: number };

const DEFAULT: Lapse = { from: 6 * 60, to: 23 * 60 + 40, ms: 10_000 };

const minutes = (hm: string | undefined) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm ?? '');
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
};

export function readLapse(search: string): Lapse {
  const query = new URLSearchParams(search);
  const [a, b] = (query.get('timelapse') ?? '').split('-');
  const from = minutes(a);
  const to = minutes(b);
  const seconds = Number(query.get('seconds'));
  return {
    ...(from !== null && to !== null && from !== to ? { from, to } : { from: DEFAULT.from, to: DEFAULT.to }),
    ms: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT.ms,
  };
}

/** The moment shown at `progress` (0..1, held at the ends), on the day of `day`. */
export function lapseAt({ from, to }: Lapse, progress: number, day: Date): Date {
  const span = to > from ? to - from : to + 24 * 60 - from;
  const at = from + span * Math.min(1, Math.max(0, progress));
  const date = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  date.setMinutes(Math.round(at));
  return date;
}
