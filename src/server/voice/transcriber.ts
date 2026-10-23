import type { SpeechLanguage } from '../../shared/protocol.js';

/** One short clip in, its transcript out. Both speech-to-text backends implement this. */
export type TranscriberConfig = { apiKey: string; timeoutMs: number };
export type Transcript = { text: string; language: string };
export type TranscribeOptions = { mime: string; language?: Exclude<SpeechLanguage, 'auto'> };

export interface Transcriber {
  transcribe(audio: Buffer, options: TranscribeOptions): Promise<Transcript>;
}
