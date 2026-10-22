import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VolcengineProvider } from '../src/server/voice/provider.js';

const voice = { id: 'zh_female_vv_uranus_bigtts', resourceId: 'seed-tts-2.0' };
const config = { apiKey: 'volc-key', timeoutMs: 5000, userId: 'test' };

/** One successful chunked response, recording the request body. */
function fakeFetch() {
  const calls: string[] = [];
  const impl = (async (_url: string, req: RequestInit) => {
    calls.push(String(req.body));
    const line = JSON.stringify({ code: 0, data: Buffer.alloc(96, 1).toString('base64') });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(line)); controller.close(); },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const additionsOf = (body: string) => (JSON.parse(body) as { req_params: { additions?: string } }).req_params.additions;

test('omits additions entirely when no language is given', async () => {
  const { impl, calls } = fakeFetch();
  await new VolcengineProvider(config, impl).synthesize({ text: '你好', voice, speechRate: 0 }, { format: 'pcm' });
  assert.equal(additionsOf(calls[0]!), undefined);
});

test('sends explicit_language as a JSON string, not a nested object', async () => {
  const { impl, calls } = fakeFetch();
  await new VolcengineProvider(config, impl).synthesize({ text: '你好', voice, speechRate: 0, language: 'zh' }, { format: 'pcm' });
  const additions = additionsOf(calls[0]!);
  assert.equal(typeof additions, 'string');
  assert.deepEqual(JSON.parse(additions!), { explicit_language: 'zh-cn' });
});

test('maps the shared zh code onto the zh-cn spelling Volcengine expects', async () => {
  const { impl, calls } = fakeFetch();
  await new VolcengineProvider(config, impl).synthesize({ text: 'hello', voice, speechRate: 0, language: 'en' }, { format: 'pcm' });
  assert.deepEqual(JSON.parse(additionsOf(calls[0]!)!), { explicit_language: 'en' });
});
