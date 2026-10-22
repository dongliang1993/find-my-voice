import type { Settings } from '../config.js';
import type { VoiceProviderId } from '../../shared/protocol.js';
import { FishAudioProvider } from './fish.js';
import { FixtureProvider, VolcengineProvider, type TtsProvider, type VoiceRef } from './provider.js';

type VoiceSettings = Settings['voice'];

/** Builds the TTS provider for the configured backend. */
export function createTtsProvider(voice: VoiceSettings): TtsProvider {
  switch (voice.provider) {
    case 'fixture': return new FixtureProvider();
    case 'fish': return new FishAudioProvider({ apiKey: voice.fish.apiKey, model: voice.fish.model, timeoutMs: voice.timeoutMs });
    case 'volcengine': return new VolcengineProvider({ apiKey: voice.volcengine.apiKey, timeoutMs: voice.timeoutMs, userId: 'find-my-voice' });
  }
}

/** Which voice the active provider should speak with. */
export function activeVoice(voice: VoiceSettings): VoiceRef {
  switch (voice.provider) {
    case 'fish': return { id: voice.fish.referenceId, resourceId: '' };
    case 'volcengine': return { id: voice.volcengine.voiceId, resourceId: voice.volcengine.resourceId };
    case 'fixture': return { id: 'fixture', resourceId: '' };
  }
}

/** Fish has a default voice, so only a key is required; Volcengine also needs a speaker. */
export function voiceReady(voice: VoiceSettings): boolean {
  const ready: Record<VoiceProviderId, boolean> = {
    fixture: true,
    fish: Boolean(voice.fish.apiKey),
    volcengine: Boolean(voice.volcengine.apiKey && voice.volcengine.voiceId && voice.volcengine.resourceId),
  };
  return ready[voice.provider];
}
