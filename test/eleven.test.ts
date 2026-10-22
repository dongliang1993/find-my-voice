import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ElevenLabsProvider } from '../src/server/voice/eleven.js';
import { DomainError } from '../src/server/errors.js';

const voice = { id: 'voice-abc', resourceId: '' };
const config = { apiKey: 'eleven-key', model: 'eleven_v4' as const, language: 'auto' as const, stability: 0.5, similarity: 0.8, timeoutMs: 5000 };

/** A fetch that returns the given byte pieces as a stream, recording the request. */
function fakeFetch(pieces: Buffer[], init: { status?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, req: RequestInit) => {
    calls.push({ url, init: req });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { for (const p of pieces) controller.enqueue(new Uint8Array(p)); controller.close(); },
    });
    return new Response(stream, { status: init.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('posts to the stream endpoint with the api key header and a JSON body', async () => {
  const { impl, calls } = fakeFetch([Buffer.alloc(96, 1)]);
  await new ElevenLabsProvider(config, impl).synthesize({ text: 'hi', voice, speechRate: 0 }, { format: 'pcm' });
  const [call] = calls;
  assert.equal(call?.url, 'https://api.elevenlabs.io/v1/text-to-speech/voice-abc/stream?output_format=pcm_24000');
  const headers = call!.init.headers as Record<string, string>;
  assert.equal(headers['xi-api-key'], 'eleven-key');
  assert.equal(headers['Content-Type'], 'application/json');
  const body = JSON.parse(call!.init.body as string) as Record<string, unknown>;
  assert.equal(body.text, 'hi');
  assert.equal(body.model_id, 'eleven_v4');
});

test('sends voice settings built from the stored knobs', async () => {
  const { impl, calls } = fakeFetch([Buffer.alloc(96)]);
  await new ElevenLabsProvider(config, impl).synthesize({ text: 'x', voice, speechRate: 0 }, { format: 'pcm' });
  const body = JSON.parse(calls[0]!.init.body as string) as { voice_settings: Record<string, unknown> };
  assert.equal(body.voice_settings.stability, 0.5);
  assert.equal(body.voice_settings.similarity_boost, 0.8);
  assert.equal(body.voice_settings.use_speaker_boost, true);
});

test('clamps speech rate into the narrow speed range ElevenLabs accepts', async () => {
  for (const [rate, expected] of [[100, 1.2], [-50, 0.7], [0, 1]] as const) {
    const { impl, calls } = fakeFetch([Buffer.alloc(96)]);
    await new ElevenLabsProvider(config, impl).synthesize({ text: 'x', voice, speechRate: rate }, { format: 'pcm' });
    const body = JSON.parse(calls[0]!.init.body as string) as { voice_settings: { speed: number } };
    assert.equal(body.voice_settings.speed, expected);
  }
});

test('auto mode infers the language from the text', async () => {
  for (const [text, expected] of [['你好呀', 'zh'], ['hello there', 'en']] as const) {
    const { impl, calls } = fakeFetch([Buffer.alloc(96)]);
    await new ElevenLabsProvider(config, impl).synthesize({ text, voice, speechRate: 0 }, { format: 'pcm' });
    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    assert.equal(body.language_code, expected);
  }
});

test('an explicit language wins over what the text looks like', async () => {
  for (const forced of ['zh', 'en'] as const) {
    const { impl, calls } = fakeFetch([Buffer.alloc(96)]);
    // Chinese text, but the setting says English: the setting must win.
    await new ElevenLabsProvider({ ...config, language: forced }, impl).synthesize({ text: '你好呀', voice, speechRate: 0 }, { format: 'pcm' });
    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    assert.equal(body.language_code, forced);
  }
});

test('omits the language hint for multilingual_v2, which rejects it', async () => {
  const { impl, calls } = fakeFetch([Buffer.alloc(96)]);
  await new ElevenLabsProvider({ ...config, model: 'eleven_multilingual_v2' }, impl)
    .synthesize({ text: '你好', voice, speechRate: 0 }, { format: 'pcm' });
  const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
  assert.equal('language_code' in body, false);
});

test('streams whole 16-bit samples even when a chunk splits one', async () => {
  const pcm = Buffer.from(Array.from({ length: 480 }, (_, i) => i % 251));
  const { impl } = fakeFetch([pcm.subarray(0, 33), pcm.subarray(33, 100), pcm.subarray(100)]);
  const chunks: Buffer[] = [];
  const result = await new ElevenLabsProvider(config, impl).synthesize(
    { text: 'x', voice, speechRate: 0 }, { format: 'pcm', onAudioChunk: async c => { chunks.push(c); } });
  assert.deepEqual(Buffer.concat(chunks), pcm);
  assert.ok(chunks.every(c => c.length % 2 === 0), 'every chunk holds whole 16-bit samples');
  // The archived copy must be a playable WAV, not bare PCM.
  assert.equal(result.audio.toString('ascii', 0, 4), 'RIFF');
  assert.equal(result.audio.subarray(44).length, pcm.length);
  assert.ok(Math.abs((result.durationSeconds ?? 0) - 480 / 48000) < 1e-9);
});

test('an empty audio response is incomplete, not success', async () => {
  const { impl } = fakeFetch([]);
  await assert.rejects(new ElevenLabsProvider(config, impl).synthesize({ text: 'x', voice, speechRate: 0 }, { format: 'pcm' }),
    (e: DomainError) => e.code === 'TTS_INCOMPLETE');
});

test('maps HTTP failures to clear errors without leaking the response body', async () => {
  const cases: [number, string][] = [[401, 'TTS_PERMISSION_DENIED'], [403, 'TTS_PERMISSION_DENIED'], [404, 'TTS_VOICE_NOT_FOUND'], [429, 'TTS_QUOTA_EXCEEDED'], [500, 'TTS_REJECTED']];
  for (const [status, code] of cases) {
    const { impl } = fakeFetch([Buffer.from('{"secret":"do not echo"}')], { status });
    await assert.rejects(new ElevenLabsProvider(config, impl).synthesize({ text: 'x', voice, speechRate: 0 }, { format: 'pcm' }),
      (e: DomainError) => e.code === code && !e.message.includes('do not echo'));
  }
});

test('requires both an API key and a voice id before calling out', async () => {
  const noKey = fakeFetch([]);
  await assert.rejects(new ElevenLabsProvider({ ...config, apiKey: '' }, noKey.impl).synthesize({ text: 'x', voice, speechRate: 0 }),
    (e: DomainError) => e.code === 'SETUP_REQUIRED');
  assert.equal(noKey.calls.length, 0);

  const noVoice = fakeFetch([]);
  await assert.rejects(new ElevenLabsProvider(config, noVoice.impl).synthesize({ text: 'x', voice: { id: '', resourceId: '' }, speechRate: 0 }),
    (e: DomainError) => e.code === 'SETUP_REQUIRED');
  assert.equal(noVoice.calls.length, 0);
});

test('an abort surfaces as stopped, not as a connection failure', async () => {
  const controller = new AbortController();
  const impl = (async (_url: string, req: RequestInit) => {
    controller.abort();
    req.signal?.throwIfAborted();
    throw new Error('unreachable');
  }) as unknown as typeof fetch;
  await assert.rejects(new ElevenLabsProvider(config, impl).synthesize({ text: 'x', voice, speechRate: 0 }, { format: 'pcm', signal: controller.signal }),
    (e: DomainError) => e.code === 'PLAYBACK_STOPPED');
});
