import type { Comfort, Rhythm } from '@shared/protocol';

/**
 * What she asks, in order. The first meeting is a conversation, not a form:
 * every question is one she would actually ask someone she just met, and the
 * answers are what she starts knowing about you.
 *
 * All in English, the way the film opens: she is not from here either, and
 * the two of you are still finding a shared language.
 */
export const SCRIPT = {
  wake: "Hi, I'm here.",
  askAlias: 'What should I call you?',
  nameEcho: (name: string) => `Nice to meet you, ${name}.`,
  comfortAsk: "When you're having a bad day, what do you want me to do?",
  comfortEcho: (label: string) => `${label}. Noted.`,
  rhythmAsk: 'When do you most want someone to talk to?',
  rhythmEcho: (label: string) => `${label}, then. I'll think of you around then.`,
  notesAsk: 'Is anything sitting on your mind lately?',
  notesEcho: "Mm. I'll remember that.",
  nameAsk: 'Last thing: what do you want to call me?',
  nameHerself: 'Or I could pick one myself.',
  proposeIntro: "I've got one.",
  proposeFallback: "(Can't think of a good one. You pick — I'm not fussy.)",
  finalEcho: (alias: string, name: string) => `Then that's settled: I'm ${name}, you're ${alias}. You can change it anytime, but I'll remember what you told me.`,
  /** Her first line on the stage: the hour they said they want company, and their name. */
  arrival: (alias: string, rhythm: Rhythm) => `${ARRIVAL_WHEN[rhythm]}, come find me${alias ? `, ${alias}` : ''}.`,
} as const;

const ARRIVAL_WHEN: Record<Rhythm, string> = {
  morning: 'In the morning, when you want to talk',
  commute: 'On your way home, when you want to talk',
  night: 'Late at night, when you want to talk',
  anytime: 'Whenever you want to talk',
};

/** What she says once when someone stalls, and only then. Fixed audio, so they never carry a name. */
export const HINTS = {
  open: { key: 'hint_open', text: 'You can just say it, or type it. Either is fine.' },
  choice: { key: 'hint_choice', text: "Whichever feels closest. There's no wrong one." },
  notes: { key: 'hint_notes', text: "It can be something small. Or skip it, that's fine too." },
  stage: { key: 'hint_stage', text: "You can just say it, or type. I'm right here." },
} as const;
export type Hint = (typeof HINTS)[keyof typeof HINTS];

/**
 * Pre-generated with the configured voice (scripts/pregen-onboarding.mjs). A
 * hit plays the archive instead of calling the API: zero latency, zero quota.
 * Only the echoes and the closing line are left on the live path.
 */
export const FIXED: { key: string; text: string }[] = [
  { key: 'wake', text: SCRIPT.wake },
  { key: 'ask_alias', text: SCRIPT.askAlias },
  { key: 'comfort_ask', text: SCRIPT.comfortAsk },
  { key: 'rhythm_ask', text: SCRIPT.rhythmAsk },
  { key: 'notes_ask', text: SCRIPT.notesAsk },
  { key: 'name_ask', text: SCRIPT.nameAsk },
  { key: 'name_herself', text: SCRIPT.nameHerself },
  { key: 'propose_intro', text: SCRIPT.proposeIntro },
  ...Object.values(HINTS),
];

/**
 * The questions, in the order she asks them. The stored step is this list's
 * position + 1, so the order lives here and nowhere else; step 0 is the
 * opening, and a finished meeting is `ASKS.length + 1`.
 */
export const ASKS = ['alias', 'comfort', 'rhythm', 'notes', 'name'] as const;
export type Ask = (typeof ASKS)[number];
export const stepOf = (ask: Ask) => ASKS.indexOf(ask) + 1;

export const COMFORT_LABELS: Record<Comfort, string> = {
  listen: 'Just listen', advise: 'Help me think', cheer: 'Cheer me up', depends: 'Depends',
};
export const RHYTHM_LABELS: Record<Rhythm, string> = {
  morning: 'In the morning', commute: 'On the way home', night: 'Late at night', anytime: 'No set time',
};
