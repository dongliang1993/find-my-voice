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
  /** `paper`: she wrote something down; the history shows it as a card that opens it. */
  kind: 'text' | 'voice' | 'paper';
  /**
   * Text body; for voice messages, the spoken transcript; for a paper, a
   * one-line summary of it (title and item names) — what her memory reads.
   */
  text: string;
  emotion: string | null;
  audio: AudioInfo | null;
  createdAt: string;
  initiative: InitiativeKind | null;
  /** Set on `paper` messages. */
  paperId?: string | null;
};

// ---- papers ----

/** Where an item opens: the page builds the search from this, the model never writes a URL. */
export type PaperLinkKind = 'movie' | 'music' | 'book' | 'place' | 'web';
export type PaperLink = { kind: PaperLinkKind; query: string };

/**
 * One piece of a paper. Ids are stable for the life of the paper: an edit
 * that inserts gets a new one, and nothing ever renumbers.
 */
export type PaperBlock =
  | { id: string; type: 'paragraph'; text: string }
  | { id: string; type: 'heading'; text: string }
  | { id: string; type: 'item'; name: string; note: string; link: PaperLink | null }
  /** A to-do line: the box is ticked by a click, from here or by her. */
  | { id: string; type: 'check'; text: string; done: boolean };

/** `writing` while she writes it; `done` once she stops — finished, or as far as it got. */
export type PaperStatus = 'writing' | 'done';

/**
 * Everything she writes down is a paper: a list, a plan, a few films, a
 * letter. One kind of thing, written, edited and kept the same way. Every
 * paper is kept; saving one only puts it on the Papers list.
 */
export type Paper = {
  id: string;
  title: string;
  status: PaperStatus;
  /** Bumped by every edit; older versions are kept on the server, not sent. */
  version: number;
  blocks: PaperBlock[];
  createdAt: string;
  /** When it went onto the Papers list; null while it is only on the stage, or in the history. */
  savedAt: string | null;
};

/** One change an edit made, with ids already resolved: what the page animates. */
export type PaperOp =
  | { op: 'replace'; blockId: string; block: PaperBlock }
  | { op: 'delete'; blockId: string }
  /** `afterBlockId` null: at the very top. */
  | { op: 'insert'; afterBlockId: string | null; block: PaperBlock };

export type CompanionStatus = 'idle' | 'thinking';

export type ClientEvent =
  | { type: 'send'; clientId: string; text: string }
  | { type: 'interrupt' }
  /** The page reports whether it is on screen, so she only rings the OS when nobody is looking. */
  | { type: 'presence'; visible: boolean }
  /** Which paper is open in the Papers app, if any: what the user says next may be about it. */
  | { type: 'reading'; paperId: string | null };

export type ServerEvent =
  /** `papers`: every paper still around, newest first; `stage`: the one on the stage. */
  | { type: 'hello'; messages: ChatMessage[]; status: CompanionStatus; papers: Paper[]; stage: string | null }
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
  /** The latest full state of a paper: created, growing while she writes, finished, edited by hand, saved. */
  | { type: 'paper'; paper: Paper }
  /** She changed a paper: the new state, and the changes in order, so the page can show her making them. */
  | { type: 'paper_edit'; paper: Paper; ops: PaperOp[] }
  /** Deleted from the Papers list. */
  | { type: 'paper_removed'; paperId: string }
  /** Which paper is on the stage now; null when the stage is clear. */
  | { type: 'stage'; paperId: string | null }
  /** A setting changed somewhere other than the settings page — she was asked to, out loud. */
  | { type: 'settings' }
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
  companion: { name: string; language: ReplyLanguage; voiceFirst: boolean };
  /** The language the app's own words are in. `auto` follows the system. */
  ui: { language: 'auto' | 'zh' | 'en' };
  initiative: InitiativeSettings;
  brain: { baseUrl: string; model: string; hasApiKey: boolean };
  voice: {
    provider: VoiceProviderId; speechRate: number; timeoutMs: number;
    volcengine: { resourceId: string; voiceId: string; hasApiKey: boolean };
    fish: { referenceId: string; model: FishModel; hasApiKey: boolean };
    elevenlabs: {
      voiceId: string; model: ElevenModel;
      stability: number; similarity: number; speakerBoost: boolean; hasApiKey: boolean;
    };
  };
};

export type SettingsUpdate = {
  companion?: { name?: string; userName?: string; language?: ReplyLanguage; voiceFirst?: boolean };
  ui?: { language?: 'auto' | 'zh' | 'en' };
  initiative?: Partial<Pick<InitiativeSettings, 'mode' | 'notify'>>;
  brain?: { baseUrl?: string; apiKey?: string; model?: string };
  voice?: {
    provider?: VoiceProviderId; speechRate?: number;
    volcengine?: { apiKey?: string; resourceId?: string; voiceId?: string };
    fish?: { apiKey?: string; referenceId?: string; model?: FishModel };
    elevenlabs?: {
      apiKey?: string; voiceId?: string; model?: ElevenModel;
      stability?: number; similarity?: number; speakerBoost?: boolean;
    };
  };
};
