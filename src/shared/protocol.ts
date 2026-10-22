// Wire protocol between the browser and the local server. Shared by both sides
// so the two cannot drift apart.

export type AudioState = 'streaming' | 'ready' | 'stopped' | 'failed';
export type AudioInfo = { id: string; state: AudioState; durationSeconds: number | null; error: string | null };

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  kind: 'text' | 'voice';
  /** Text body; for voice messages, the spoken transcript. */
  text: string;
  emotion: string | null;
  audio: AudioInfo | null;
  createdAt: string;
};

export type CompanionStatus = 'idle' | 'thinking';

export type ClientEvent =
  | { type: 'send'; clientId: string; text: string }
  | { type: 'interrupt' };

export type ServerEvent =
  | { type: 'hello'; messages: ChatMessage[]; status: CompanionStatus }
  /** A new message, or the latest full state of an existing one. */
  | { type: 'message'; message: ChatMessage }
  | { type: 'text_delta'; messageId: string; delta: string }
  /** Base64 PCM, signed 16-bit little-endian, mono. */
  | { type: 'audio_chunk'; audioId: string; data: string }
  | { type: 'status'; status: CompanionStatus }
  | { type: 'error'; code: string; message: string };

export const PCM_SAMPLE_RATE = 24000;

// ---- REST: status and settings ----

export type BrainSource = 'app' | 'claude-code' | 'environment' | 'none';
export type VoiceProviderId = 'volcengine' | 'fish' | 'fixture';
export type FishModel = 's1' | 's1-mini' | 'speech-1.6' | 'speech-1.5';
export type AppStatus = {
  companionName: string;
  brain: { source: BrainSource; ready: boolean; model: string | null };
  voice: { provider: VoiceProviderId; ready: boolean };
};

/** Settings as the browser sees them: secrets reduced to presence flags. */
export type PublicSettings = {
  companion: { name: string };
  brain: { baseUrl: string; model: string; hasApiKey: boolean };
  voice: {
    provider: VoiceProviderId; speechRate: number; timeoutMs: number;
    volcengine: { resourceId: string; voiceId: string; hasApiKey: boolean };
    fish: { referenceId: string; model: FishModel; hasApiKey: boolean };
  };
};

export type SettingsUpdate = {
  companion?: { name?: string };
  brain?: { baseUrl?: string; apiKey?: string; model?: string };
  voice?: {
    provider?: VoiceProviderId; speechRate?: number;
    volcengine?: { apiKey?: string; resourceId?: string; voiceId?: string };
    fish?: { apiKey?: string; referenceId?: string; model?: FishModel };
  };
};
