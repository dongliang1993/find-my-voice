import type { Settings } from '../config.js';
import type { VoiceProviderId } from '../../shared/protocol.js';
import { FishAudioProvider } from './fish.js';
import { ElevenLabsProvider } from './eleven.js';
import { FixtureProvider, VolcengineProvider, type TtsProvider, type VoiceRef } from './provider.js';
import { ElevenLabsTranscriber } from './scribe.js';
import { VolcengineTranscriber } from './volc-asr.js';
import type { Transcriber } from './transcriber.js';

type VoiceSettings = Settings['voice'];

/** Builds the TTS provider for the configured backend. */
export function createTtsProvider(voice: VoiceSettings): TtsProvider {
  switch (voice.provider) {
    case 'fixture': return new FixtureProvider();
    case 'fish': return new FishAudioProvider({ apiKey: voice.fish.apiKey, model: voice.fish.model, timeoutMs: voice.timeoutMs });
    case 'elevenlabs': return new ElevenLabsProvider({
      apiKey: voice.elevenlabs.apiKey, model: voice.elevenlabs.model, language: voice.elevenlabs.language,
      stability: voice.elevenlabs.stability, similarity: voice.elevenlabs.similarity, timeoutMs: voice.timeoutMs,
    });
    case 'volcengine': return new VolcengineProvider({ apiKey: voice.volcengine.apiKey, timeoutMs: voice.timeoutMs, userId: 'find-my-voice' });
  }
}

/** Which voice the active provider should speak with. */
export function activeVoice(voice: VoiceSettings): VoiceRef {
  switch (voice.provider) {
    case 'fish': return { id: voice.fish.referenceId, resourceId: '' };
    case 'elevenlabs': return { id: voice.elevenlabs.voiceId, resourceId: '' };
    case 'volcengine': return { id: voice.volcengine.voiceId, resourceId: voice.volcengine.resourceId };
    case 'fixture': return { id: 'fixture', resourceId: '' };
  }
}

/** Fish has a default voice, so only a key is required; the others also need a speaker. */
export function voiceReady(voice: VoiceSettings): boolean {
  const ready: Record<VoiceProviderId, boolean> = {
    fixture: true,
    fish: Boolean(voice.fish.apiKey),
    elevenlabs: Boolean(voice.elevenlabs.apiKey && voice.elevenlabs.voiceId),
    volcengine: Boolean(voice.volcengine.apiKey && voice.volcengine.voiceId && voice.volcengine.resourceId),
  };
  return ready[voice.provider];
}

/**
 * Speech-to-text. The same provider that speaks also listens: an ElevenLabs
 * key hears through Scribe, a Volcengine key through its flash recogniser, so
 * nobody has to buy a second vendor just to answer out loud.
 */
export function createTranscriber(voice: VoiceSettings): Transcriber {
  return voice.provider === 'volcengine'
    ? new VolcengineTranscriber({ apiKey: voice.volcengine.apiKey, timeoutMs: voice.timeoutMs })
    : new ElevenLabsTranscriber({ apiKey: voice.elevenlabs.apiKey, timeoutMs: voice.timeoutMs });
}

/** Whether she can hear at all: the speaking provider needs a key of its own. */
export function listenReady(voice: VoiceSettings): boolean {
  return voice.provider === 'volcengine'
    ? Boolean(voice.volcengine.apiKey)
    : Boolean(voice.elevenlabs.apiKey);
}
