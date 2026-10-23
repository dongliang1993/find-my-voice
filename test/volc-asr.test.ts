import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VolcengineTranscriber } from '../src/server/voice/volc-asr.js';
import { DomainError } from '../src/server/errors.js';

const config = { apiKey: 'volc-key', timeoutMs: 5000 };
const clip = Buffer.from('fake-opus-bytes');

/** A fetch that answers with the status header Volcengine puts its verdict in. */
function fakeFetch(body: unknown, { code = '20000000', status = 200 } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', 'X-Api-Status-Code': code, 'X-Tt-Logid': 'log-1' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ok = { result: { text: '  叫我阿良就行 ', utterances: [] } };

test('posts base64 audio to the flash endpoint with the fixed resource id', async () => {
  const { impl, calls } = fakeFetch(ok);
  await new VolcengineTranscriber(config, impl).transcribe(clip, { mime: 'audio/webm' });
  const [call] = calls;
  assert.equal(call?.url, 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash');
  const headers = call!.init.headers as Record<string, string>;
  assert.equal(headers['X-Api-Key'], 'volc-key');
  assert.equal(headers['X-Api-Resource-Id'], 'volc.bigasr.auc_turbo');
  assert.equal(headers['X-Api-Sequence'], '-1');
  const body = JSON.parse(call!.init.body as string) as Record<string, unknown>;
  assert.deepEqual(body.audio, { data: clip.toString('base64'), format: 'webm' });
  assert.equal((body.request as Record<string, unknown>).model_name, 'bigmodel');
});

test('puts the browser mime into the format field the endpoint wants', async () => {
  for (const [mime, format] of [['audio/webm;codecs=opus', undefined], ['audio/ogg', 'ogg'], ['audio/mp4', 'mp4']] as const) {
    const bare = mime.split(';')[0]!;
    const { impl, calls } = fakeFetch(ok);
    await new VolcengineTranscriber(config, impl).transcribe(clip, { mime: bare });
    const body = JSON.parse(calls[0]!.init.body as string) as { audio: { format: string } };
    assert.equal(body.audio.format, format ?? 'webm');
  }
});

test('sends a language tag only when one is given', async () => {
  const hinted = fakeFetch(ok);
  await new VolcengineTranscriber(config, hinted.impl).transcribe(clip, { mime: 'audio/webm', language: 'zh' });
  assert.equal((JSON.parse(hinted.calls[0]!.init.body as string) as { audio: { language?: string } }).audio.language, 'zh-CN');
  const open = fakeFetch(ok);
  await new VolcengineTranscriber(config, open.impl).transcribe(clip, { mime: 'audio/webm' });
  assert.equal((JSON.parse(open.calls[0]!.init.body as string) as { audio: { language?: string } }).audio.language, undefined);
});

test('returns the trimmed transcript', async () => {
  const { impl } = fakeFetch(ok);
  const result = await new VolcengineTranscriber(config, impl).transcribe(clip, { mime: 'audio/webm' });
  assert.equal(result.text, '叫我阿良就行');
});

test('silence is an empty transcript, not a failure', async () => {
  const { impl } = fakeFetch({ audio_info: { duration: 1480 }, result: { text: '' } }, { code: '20000003' });
  assert.deepEqual(await new VolcengineTranscriber(config, impl).transcribe(clip, { mime: 'audio/webm' }), { text: '', language: '' });
});

test('requires a key before calling out', async () => {
  const { impl, calls } = fakeFetch(ok);
  await assert.rejects(new VolcengineTranscriber({ ...config, apiKey: '' }, impl).transcribe(clip, { mime: 'audio/webm' }),
    (e: unknown) => e instanceof DomainError && e.code === 'SETUP_REQUIRED');
  assert.equal(calls.length, 0);
});

test('rejects a format it cannot name', async () => {
  const { impl, calls } = fakeFetch(ok);
  await assert.rejects(new VolcengineTranscriber(config, impl).transcribe(clip, { mime: 'audio/x-flac' }),
    (e: unknown) => e instanceof DomainError && e.code === 'STT_INVALID_INPUT');
  assert.equal(calls.length, 0);
});

test('an error status code is a failure even on HTTP 200', async () => {
  const { impl } = fakeFetch({}, { code: '45000151' });
  await assert.rejects(new VolcengineTranscriber(config, impl).transcribe(clip, { mime: 'audio/webm' }),
    (e: unknown) => e instanceof DomainError && e.code === 'STT_INVALID_INPUT');
});

test('an unknown status code still fails, carrying the log id', async () => {
  const { impl } = fakeFetch({}, { code: '55099999' });
  await assert.rejects(new VolcengineTranscriber(config, impl).transcribe(clip, { mime: 'audio/webm' }),
    (e: unknown) => e instanceof DomainError && e.code === 'STT_REJECTED' && e.details?.log_id === 'log-1');
});

test('a timeout is reported as such', async () => {
  const impl = (async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }) as unknown as typeof fetch;
  await assert.rejects(new VolcengineTranscriber(config, impl).transcribe(clip, { mime: 'audio/webm' }),
    (e: unknown) => e instanceof DomainError && e.code === 'STT_TIMEOUT');
});

test('a malformed body is an error, not an empty name', async () => {
  const { impl } = fakeFetch({ nope: true });
  await assert.rejects(new VolcengineTranscriber(config, impl).transcribe(clip, { mime: 'audio/webm' }),
    (e: unknown) => e instanceof DomainError && e.code === 'STT_INCOMPLETE');
});
