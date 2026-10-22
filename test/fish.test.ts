import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode } from '@msgpack/msgpack';
import { FishAudioProvider } from '../src/server/voice/fish.js';
import { DomainError } from '../src/server/errors.js';

const voice = { id: 'ref-123', resourceId: '' };
const config = { apiKey: 'fish-key', model: 's1' as const, timeoutMs: 5000 };

function wavHeader(pcmBytes: number, { sampleRate = 24000, channels = 1, bits = 16, dataSize = pcmBytes } = {}) {
  const h = Buffer.alloc(44);
  h.write('RIFF'); h.writeUInt32LE(Math.min(0xffffffff, 36 + dataSize), 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * channels * bits / 8, 28);
  h.writeUInt16LE(channels * bits / 8, 32); h.writeUInt16LE(bits, 34); h.write('data', 36); h.writeUInt32LE(dataSize, 40);
  return h;
}

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

test('sends the request the official SDK sends: msgpack body, bearer auth, model header', async () => {
  const pcm = Buffer.alloc(480, 3);
  const { impl, calls } = fakeFetch([wavHeader(pcm.length), pcm]);
  await new FishAudioProvider(config, impl).synthesize({ text: '你好', voice, speechRate: 0 }, { format: 'pcm' });
  const [call] = calls;
  assert.equal(call?.url, 'https://api.fish.audio/v1/tts');
  const headers = call!.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer fish-key');
  assert.equal(headers.model, 's1');
  assert.equal(headers['Content-Type'], 'application/msgpack');
  const body = decode(call!.init.body as Uint8Array) as Record<string, unknown>;
  assert.equal(body.text, '你好');
  assert.equal(body.reference_id, 'ref-123');
  assert.equal(body.format, 'wav');
  assert.equal(body.sample_rate, 24000);
  assert.equal(body.latency, 'balanced');
});

test('maps speech rate to a prosody speed multiplier', async () => {
  const pcm = Buffer.alloc(4);
  const { impl, calls } = fakeFetch([wavHeader(4), pcm]);
  await new FishAudioProvider(config, impl).synthesize({ text: 'x', voice, speechRate: 50 }, { format: 'pcm' });
  const body = decode(calls[0]!.init.body as Uint8Array) as { prosody?: { speed: number } };
  assert.equal(body.prosody?.speed, 1.5);
});

test('omits reference_id when no voice is chosen, so Fish uses its default voice', async () => {
  const { impl, calls } = fakeFetch([wavHeader(4), Buffer.alloc(4)]);
  await new FishAudioProvider(config, impl).synthesize({ text: 'x', voice: { id: '', resourceId: '' }, speechRate: 0 }, { format: 'pcm' });
  const body = decode(calls[0]!.init.body as Uint8Array) as Record<string, unknown>;
  assert.equal('reference_id' in body, false);
});

test('streams PCM after the WAV header, even when the header is split across chunks', async () => {
  const pcm = Buffer.from(Array.from({ length: 960 }, (_, i) => i % 251));
  const wav = Buffer.concat([wavHeader(pcm.length), pcm]);
  // Split at awkward places: mid-header, and an odd byte boundary mid-sample.
  const { impl } = fakeFetch([wav.subarray(0, 20), wav.subarray(20, 101), wav.subarray(101)]);
  const chunks: Buffer[] = [];
  const result = await new FishAudioProvider(config, impl).synthesize(
    { text: 'x', voice, speechRate: 0 }, { format: 'pcm', onAudioChunk: async c => { chunks.push(c); } });
  const streamed = Buffer.concat(chunks);
  assert.deepEqual(streamed, pcm);
  assert.ok(chunks.every(c => c.length % 2 === 0), 'every chunk holds whole 16-bit samples');
  assert.equal(result.extension, 'wav');
  assert.ok(Math.abs((result.durationSeconds ?? 0) - 960 / 48000) < 1e-9);
});

test('accepts a streaming WAV whose data size is a placeholder', async () => {
  const pcm = Buffer.alloc(200, 1);
  const { impl } = fakeFetch([wavHeader(pcm.length, { dataSize: 0xffffffff }), pcm]);
  const chunks: Buffer[] = [];
  await new FishAudioProvider(config, impl).synthesize({ text: 'x', voice, speechRate: 0 }, { format: 'pcm', onAudioChunk: async c => { chunks.push(c); } });
  assert.equal(Buffer.concat(chunks).length, 200);
});

test('rejects audio that is not 24 kHz 16-bit mono instead of playing noise', async () => {
  for (const bad of [{ sampleRate: 44100 }, { channels: 2 }, { bits: 8 }]) {
    const { impl } = fakeFetch([wavHeader(8, bad), Buffer.alloc(8)]);
    await assert.rejects(new FishAudioProvider(config, impl).synthesize({ text: 'x', voice, speechRate: 0 }, { format: 'pcm' }),
      (e: DomainError) => e.code === 'TTS_PROTOCOL_ERROR');
  }
});

test('an empty audio response is incomplete, not success', async () => {
  const { impl } = fakeFetch([wavHeader(0)]);
  await assert.rejects(new FishAudioProvider(config, impl).synthesize({ text: 'x', voice, speechRate: 0 }, { format: 'pcm' }),
    (e: DomainError) => e.code === 'TTS_INCOMPLETE');
});

test('maps HTTP failures to clear errors without leaking the response body', async () => {
  const cases: [number, string][] = [[401, 'TTS_PERMISSION_DENIED'], [402, 'TTS_QUOTA_EXCEEDED'], [404, 'TTS_VOICE_NOT_FOUND'], [429, 'TTS_QUOTA_EXCEEDED'], [500, 'TTS_REJECTED']];
  for (const [status, code] of cases) {
    const { impl } = fakeFetch([Buffer.from('{"secret":"do not echo"}')], { status });
    await assert.rejects(new FishAudioProvider(config, impl).synthesize({ text: 'x', voice, speechRate: 0 }, { format: 'pcm' }),
      (e: DomainError) => e.code === code && !e.message.includes('do not echo'));
  }
});

test('requires an API key before calling out', async () => {
  const { impl, calls } = fakeFetch([]);
  await assert.rejects(new FishAudioProvider({ ...config, apiKey: '' }, impl).synthesize({ text: 'x', voice, speechRate: 0 }),
    (e: DomainError) => e.code === 'SETUP_REQUIRED');
  assert.equal(calls.length, 0);
});

test('an abort surfaces as stopped, not as a connection failure', async () => {
  const controller = new AbortController();
  const impl = (async (_url: string, req: RequestInit) => {
    controller.abort();
    req.signal?.throwIfAborted();
    throw new Error('unreachable');
  }) as unknown as typeof fetch;
  await assert.rejects(new FishAudioProvider(config, impl).synthesize({ text: 'x', voice, speechRate: 0 }, { format: 'pcm', signal: controller.signal }),
    (e: DomainError) => e.code === 'PLAYBACK_STOPPED');
});
