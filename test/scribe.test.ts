import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ElevenLabsTranscriber } from '../src/server/voice/scribe.js';
import { DomainError } from '../src/server/errors.js';

const config = { apiKey: 'eleven-key', timeoutMs: 5000 };
const wav = Buffer.from('RIFF....WAVEfmt fake');

function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('posts the audio as multipart to scribe with the api key header', async () => {
  const { impl, calls } = fakeFetch({ text: '阿良', language_code: 'zho', language_probability: 0.9, words: [] });
  await new ElevenLabsTranscriber(config, impl).transcribe(wav, { mime: 'audio/wav' });
  const [call] = calls;
  assert.equal(call?.url, 'https://api.elevenlabs.io/v1/speech-to-text');
  assert.equal(call?.init.method, 'POST');
  assert.equal((call!.init.headers as Record<string, string>)['xi-api-key'], 'eleven-key');
  const form = call!.init.body as FormData;
  assert.equal(form.get('model_id'), 'scribe_v2');
  assert.equal(form.get('tag_audio_events'), 'false');
  const file = form.get('file') as File;
  assert.equal(file.type, 'audio/wav');
  assert.equal(file.size, wav.length);
});

test('sends a language hint only when one is given', async () => {
  const hinted = fakeFetch({ text: 'x', language_code: 'zho', language_probability: 1, words: [] });
  await new ElevenLabsTranscriber(config, hinted.impl).transcribe(wav, { mime: 'audio/wav', language: 'zh' });
  assert.equal((hinted.calls[0]!.init.body as FormData).get('language_code'), 'zh');
  const open = fakeFetch({ text: 'x', language_code: 'zho', language_probability: 1, words: [] });
  await new ElevenLabsTranscriber(config, open.impl).transcribe(wav, { mime: 'audio/wav' });
  assert.equal((open.calls[0]!.init.body as FormData).get('language_code'), null);
});

test('returns the trimmed transcript and detected language', async () => {
  const { impl } = fakeFetch({ text: '  叫我阿良就行 ', language_code: 'zho', language_probability: 0.93, words: [] });
  const result = await new ElevenLabsTranscriber(config, impl).transcribe(wav, { mime: 'audio/wav' });
  assert.deepEqual(result, { text: '叫我阿良就行', language: 'zho' });
});

test('requires a key before calling out', async () => {
  const { impl, calls } = fakeFetch({});
  await assert.rejects(new ElevenLabsTranscriber({ ...config, apiKey: '' }, impl).transcribe(wav, { mime: 'audio/wav' }),
    (e: unknown) => e instanceof DomainError && e.code === 'SETUP_REQUIRED');
  assert.equal(calls.length, 0);
});

test('maps provider failures to clear codes without echoing the body', async () => {
  for (const [status, code] of [[401, 'STT_PERMISSION_DENIED'], [402, 'STT_QUOTA_EXCEEDED'], [429, 'STT_QUOTA_EXCEEDED'], [422, 'STT_INVALID_INPUT'], [500, 'STT_REJECTED']] as const) {
    const { impl } = fakeFetch({ detail: { message: 'secret upstream detail' } }, status);
    await assert.rejects(new ElevenLabsTranscriber(config, impl).transcribe(wav, { mime: 'audio/wav' }),
      (e: unknown) => e instanceof DomainError && e.code === code && !e.message.includes('secret'));
  }
});

test('a malformed response is an error, not an empty name', async () => {
  const { impl } = fakeFetch({ nope: true });
  await assert.rejects(new ElevenLabsTranscriber(config, impl).transcribe(wav, { mime: 'audio/wav' }),
    (e: unknown) => e instanceof DomainError && e.code === 'STT_INCOMPLETE');
});

test('a timeout is reported as such', async () => {
  const impl = (async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }) as unknown as typeof fetch;
  await assert.rejects(new ElevenLabsTranscriber(config, impl).transcribe(wav, { mime: 'audio/wav' }),
    (e: unknown) => e instanceof DomainError && e.code === 'STT_TIMEOUT');
});
