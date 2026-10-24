// Wire protocol between the browser and the local server. Shared by both sides
// so the two cannot drift apart.

export type AudioState = 'streaming' | 'ready' | 'stopped' | 'failed';
export type AudioInfo = { id: string; state: AudioState; durationSeconds: number | null; error: string | null };

/**
 * Why she started talking unprompted; null for ordinary replies. Silence alone
 * is never a reason: `followup` is something you told her about, `echo` is
 * something you said that stayed with her, `rhythm` is the hour you like company.
 */
export type InitiativeKind = 'followup' | 'echo' | 'rhythm';

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  /** `letter`: she handed over a letter; the history shows it as an envelope. */
  kind: 'text' | 'voice' | 'letter';
  /**
   * Text body; for voice messages, the spoken transcript; for a letter, a
   * one-line summary of it (title and item names) — what her memory reads.
   */
  text: string;
  emotion: string | null;
  audio: AudioInfo | null;
  createdAt: string;
  initiative: InitiativeKind | null;
  /** Set on `letter` messages. */
  letterId?: string | null;
};

// ---- letters ----

/** Where an item opens: the page builds the search from this, the model never writes a URL. */
export type LetterLinkKind = 'movie' | 'music' | 'book' | 'place' | 'web';
export type LetterLink = { kind: LetterLinkKind; query: string };

/**
 * One piece of a letter. Ids are stable for the life of the letter: an edit
 * that inserts gets a new one, and nothing ever renumbers.
 */
export type LetterBlock =
  | { id: string; type: 'paragraph'; text: string }
  | { id: string; type: 'heading'; text: string }
  | { id: string; type: 'item'; name: string; note: string; link: LetterLink | null }
  /** A to-do line on a note: the box is ticked by a click, from here or by her. */
  | { id: string; type: 'check'; text: string; done: boolean };

/** `broken`: the writing stopped part-way; what was written is kept, and it can be written again. */
export type LetterStatus = 'writing' | 'done' | 'broken';

export type Letter = {
  id: string;
  title: string;
  status: LetterStatus;
  /** Bumped by every edit; older versions are kept on the server, not sent. */
  version: number;
  blocks: LetterBlock[];
  /** Her name as she signed it. */
  signature: string;
  createdAt: string;
  /** First time the user opened it; null while it is still sealed. */
  openedAt: string | null;
};

/** One change an edit made, with ids already resolved: what the paper animates. */
export type LetterOp =
  | { op: 'replace'; blockId: string; block: LetterBlock }
  | { op: 'delete'; blockId: string }
  /** `afterBlockId` null: at the very top. */
  | { op: 'insert'; afterBlockId: string | null; block: LetterBlock };

// ---- notes ----

/**
 * A note: the same blocks a letter is made of, for what is only wanted on the
 * spot — a list, a plan, a few steps. Lighter than a letter in every way:
 * one at a time, nothing kept once it is closed.
 */
export type Note = {
  id: string;
  title: string;
  status: NoteStatus;
  /** Bumped by every edit; no history is kept. */
  version: number;
  blocks: LetterBlock[];
  createdAt: string;
};

/** `writing` while she writes it; `done` once it is all there. Never `broken`: nothing is kept to retry. */
export type NoteStatus = 'writing' | 'done';

/** One change she made to a note, ids already resolved. */
export type NoteOp = LetterOp;

export type CompanionStatus = 'idle' | 'thinking';

export type ClientEvent =
  | { type: 'send'; clientId: string; text: string }
  | { type: 'interrupt' }
  /** The page reports whether it is on screen, so she only rings the OS when nobody is looking. */
  | { type: 'presence'; visible: boolean }
  /** Which letter is open on the page, if any: what the user says next is about it. */
  | { type: 'reading'; letterId: string | null };

export type ServerEvent =
  | { type: 'hello'; messages: ChatMessage[]; status: CompanionStatus; letters: Letter[]; note: Note | null; filedNotes: Note[] }
  /** A new message, or the latest full state of an existing one. */
  | { type: 'message'; message: ChatMessage }
  | { type: 'text_delta'; messageId: string; delta: string }
  /** Base64 PCM, signed 16-bit little-endian, mono. */
  | { type: 'audio_chunk'; audioId: string; data: string }
  /**
   * One sentence of speech, and the second of the stream it starts at. Sent
   * before its audio, so the caption can wait on the clock rather than the wire.
   */
  | { type: 'speech_line'; audioId: string; text: string; startsAt: number }
  | { type: 'status'; status: CompanionStatus }
  /** She started talking on her own; the browser may notify if it is in the background. */
  | { type: 'initiative'; kind: InitiativeKind; messageIds: string[] }
  /** The latest full state of a letter: created, growing while she writes, finished, or broken off. */
  | { type: 'letter'; letter: Letter }
  /** She changed a letter: the new state, and the changes in order, so the paper can show her making them. */
  | { type: 'letter_edit'; letter: Letter; ops: LetterOp[] }
  | { type: 'letter_removed'; letterId: string }
  /** The one note, on the spot: created, growing while she writes, or finished. */
  | { type: 'note'; note: Note }
  /** She changed the note: the new state, and the changes in order. */
  | { type: 'note_edit'; note: Note; ops: NoteOp[] }
  /** The note was closed on the page: it is gone, and nothing is kept. */
  | { type: 'note_removed'; noteId: string }
  /** The note was taken off the table and kept: the dock tells of it. */
  | { type: 'note_filed'; noteId: string; filedNotes: Note[] }
  /** A dock note back on the table: the dock holds one less. */
  | { type: 'note_unfiled'; noteId: string; filedNotes: Note[] }
  | { type: 'error'; code: string; message: string };

export const PCM_SAMPLE_RATE = 24000;

// ---- REST: status and settings ----

export type BrainSource = 'app' | 'claude-code' | 'environment' | 'none';
export type VoiceProviderId = 'volcengine' | 'fish' | 'elevenlabs' | 'fixture';
export type FishModel = 's1' | 's1-mini' | 'speech-1.6' | 'speech-1.5';
export type ElevenModel = 'eleven_multilingual_v2' | 'eleven_v4' | 'eleven_v4_turbo' | 'eleven_flash_v2_5';
/**
 * How the reading language is chosen. `auto` guesses from the text; the others force a normalizer.
 * Providers that spell the codes differently map from these; Fish has no equivalent at all.
 */
export type SpeechLanguage = 'auto' | 'zh' | 'en';
/** Which language she writes in. `auto` mirrors the user; the others hold. */
export type ReplyLanguage = SpeechLanguage;
export type AppStatus = {
  companionName: string;
  brain: { source: BrainSource; ready: boolean; model: string | null };
  voice: { provider: VoiceProviderId; ready: boolean };
  /** Whether she can hear: speech-to-text has a key. Without it, answers are typed. */
  listen: { ready: boolean };
};

/** What the user said aloud during onboarding, and the alias taken from it (null: none heard). */
export type HeardAlias = { said: string; alias: string | null };

export type InitiativeSettings = {
  mode: 'off' | 'occasional' | 'often'; notify: boolean;
};

/** How she should meet a bad mood. Chosen in the first meeting, kept for good. */
export type Comfort = 'listen' | 'advise' | 'cheer' | 'depends';
/** When the user tends to want company. Drives when she may reach out. */
export type Rhythm = 'morning' | 'commute' | 'night' | 'anytime';

/** One question of the first meeting, in order. */
export type OnboardingStep = 'begin' | 'alias' | 'comfort' | 'rhythm' | 'notes' | 'name' | 'done';

/** Settings as the browser sees them: secrets reduced to presence flags. */
export type PublicSettings = {
  companion: { name: string; language: ReplyLanguage };
  initiative: InitiativeSettings;
  brain: { baseUrl: string; model: string; hasApiKey: boolean };
  voice: {
    provider: VoiceProviderId; speechRate: number; timeoutMs: number;
    volcengine: { resourceId: string; voiceId: string; hasApiKey: boolean };
    fish: { referenceId: string; model: FishModel; hasApiKey: boolean };
    elevenlabs: {
      voiceId: string; model: ElevenModel;
      stability: number; similarity: number; hasApiKey: boolean;
    };
  };
};

export type SettingsUpdate = {
  companion?: { name?: string; userName?: string; language?: ReplyLanguage };
  initiative?: Partial<Pick<InitiativeSettings, 'mode' | 'notify'>>;
  brain?: { baseUrl?: string; apiKey?: string; model?: string };
  voice?: {
    provider?: VoiceProviderId; speechRate?: number;
    volcengine?: { apiKey?: string; resourceId?: string; voiceId?: string };
    fish?: { apiKey?: string; referenceId?: string; model?: FishModel };
    elevenlabs?: {
      apiKey?: string; voiceId?: string; model?: ElevenModel;
      stability?: number; similarity?: number;
    };
  };
};
