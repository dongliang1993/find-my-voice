import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PCM_SAMPLE_RATE } from '../../shared/protocol.js';
import { pcmToWav, type TtsProvider, type VoiceRef } from './provider.js';
import { splitSentences } from './sentences.js';

const BYTES_PER_SECOND = PCM_SAMPLE_RATE * 2;
// Merge short lines so a "嗯。" does not become its own request; cap length so
// the first sentence starts playing quickly.
const SPLIT = { minChars: 12, maxChars: 80 };
const SAFE_ID = /^[a-zA-Z0-9-]{1,80}$/;

export type VoicePipelineOptions = {
  provider: TtsProvider;
  audioDir: string;
  // Read on every call so settings changes apply without rebuilding the pipeline.
  voice: () => VoiceRef;
  speechRate: () => number;
  /** `auto` or undefined sends no hint; providers decide what to do with the rest. */
  language?: () => 'auto' | 'zh' | 'en';
};

export type SpeakResult = { path: string; durationSeconds: number };

/** Turns a voice message into streamed PCM plus one archived WAV per message. */
export class VoicePipeline {
  constructor(private options: VoicePipelineOptions) {
    mkdirSync(options.audioDir, { recursive: true, mode: 0o700 });
  }

  pathFor(audioId: string) {
    if (!SAFE_ID.test(audioId)) throw new Error(`Invalid audio id: ${audioId}`);
    return resolve(this.options.audioDir, `${audioId}.wav`);
  }

  /** Sentences are synthesized one after another so playback order is guaranteed. */
  async speak(audioId: string, text: string, { onChunk, signal }: { onChunk: (pcm: Buffer) => void; signal?: AbortSignal }): Promise<SpeakResult> {
    const path = this.pathFor(audioId);
    const pcm: Buffer[] = [];
    for (const sentence of splitSentences(text, SPLIT)) {
      signal?.throwIfAborted();
      const language = this.options.language?.() ?? 'auto';
      await this.options.provider.synthesize(
        { text: sentence, voice: this.options.voice(), speechRate: this.options.speechRate(), ...(language === 'auto' ? {} : { language }) },
        { format: 'pcm', signal, onAudioChunk: async chunk => { pcm.push(chunk); onChunk(chunk); } },
      );
    }
    const audio = Buffer.concat(pcm);
    writeFileSync(path, pcmToWav(audio, PCM_SAMPLE_RATE), { mode: 0o600 });
    return { path, durationSeconds: audio.length / BYTES_PER_SECOND };
  }
}
