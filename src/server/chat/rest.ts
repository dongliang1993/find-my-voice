// When she rests after a goodbye, and when she is up again on her own: at the
// start of the next hours the first meeting said the user likes company —
// never one already under way, which would be no rest at all.
import { RHYTHM_HOURS } from '../config.js';
import type { Rhythm } from '../../shared/protocol.js';

/** With no hours of their own, she is up with the morning. */
const MORNING = 8;

export function wakeAt(rhythm: Rhythm, now: Date): Date {
  const hour = RHYTHM_HOURS[rhythm]?.rhythmStart ?? MORNING;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour);
  return today > now ? today : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hour);
}
