import { timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serve } from '@hono/node-server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z, ZodError } from 'zod';
import { DomainError, errorPayload } from './errors.js';
import type { VoiceService } from './service.js';
import { createMcpServer } from './mcp.js';
import { listVoices } from './catalog.js';
import { settingsPatchSchema, watchSettings } from './config.js';

const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createHttpApp(service: VoiceService) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof ZodError || error instanceof SyntaxError) return c.json({ error: { code: 'INVALID_INPUT', message: '请求格式无效。' } }, 400);
    const status = error instanceof DomainError ? error.httpStatus : 500;
    return new Response(JSON.stringify({ error: errorPayload(error) }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  });
  app.use('*', async (c, next) => {
    const url = new URL(c.req.url);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (!loopback) throw new DomainError('INVALID_HOST', '请求 Host 不属于本地回环地址。', 403);
    c.header('X-Content-Type-Options', 'nosniff'); c.header('Referrer-Policy', 'no-referrer'); c.header('Cache-Control', 'no-store');
    await next();
  });
  app.use('/api/*', bodyLimit({ maxSize: 256 * 1024 }));
  // Service is loopback-only, so a local caller is already trusted: no session,
  // no login. Only a foreign Origin is refused, which stops another site from
  // driving the API through the browser.
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET') {
      const origin = c.req.header('Origin');
      const sameHost = origin ? new URL(origin).hostname === new URL(c.req.url).hostname : false;
      if (origin && !sameHost) throw new DomainError('INVALID_ORIGIN', '拒绝跨来源管理请求。', 403);
    }
    await next();
  });
  app.get('/health', c => c.json({ ok: true, name: 'finding-my-voice', provider: service.config.provider }));
  app.get('/api/state', c => {
    service.assets.cleanup();
    return c.json({ ...service.context(), pending: service.store.pendingList(service.config.ownerId),
      voices: listVoices(service.config), speeches: service.store.export(service.config.ownerId).speeches.slice(-20).reverse(),
      // Everything editable lives at GET /api/settings; state only carries what
      // the rest of the page needs to render.
      configuration: { provider: service.config.provider, api_mode: service.config.apiMode,
        resource_configured: Boolean(service.config.volc.resourceId || listVoices(service.config).some(v => v.enabled && v.resource_id)),
        settings_path: resolve(service.config.dataDir, 'settings.json'),
        max_characters: service.config.maxCharacters },
    });
  });
  app.get('/api/setup', c => c.json(service.setup(false).data));
  app.post('/api/decision', async c => {
    const body = z.object({ id: z.string().uuid(), approve: z.boolean(), selected_indices: z.array(z.number().int().min(0)).optional() }).strict().parse(await c.req.json());
    return c.json(service.decide(body.id, body.approve, body.selected_indices));
  });
  app.post('/api/memory/deactivate', async c => {
    const body = z.object({ id: z.string().uuid() }).strict().parse(await c.req.json());
    service.store.deactivateMemory(service.config.ownerId, body.id); return c.json({ ok: true });
  });
  app.get('/api/export', c => c.json({ ...service.store.export(service.config.ownerId), profile_documents: service.context().profile_documents }));
  // Secrets are returned as flags only, never in the clear.
  app.get('/api/settings', c => c.json(service.settings()));
  // Partial patch: the page sends one group at a time and the merge fills the rest.
  app.post('/api/settings', async c => c.json(service.applySettings(settingsPatchSchema.parse(await c.req.json()))));
  app.get('/api/audio/:id/refresh', c => c.json(service.assets.publicResult(service.store.speech(service.config.ownerId, c.req.param('id')))));
  // Owner UI provides a concrete way to test/audition voices without another MCP business tool.
  app.post('/api/speak', async c => c.json(await service.speak(await c.req.json(), true, false)));

  const adminHtml = () => readFileSync(resolve(service.config.root, 'public/admin.html'), 'utf8');
  app.get('/', c => c.redirect('/admin'));
  app.get('/admin', c => { c.header('X-Frame-Options', 'DENY'); return c.html(adminHtml()); });
  app.get('/review/:id', c => { c.header('X-Frame-Options', 'DENY'); return c.html(adminHtml()); });

  const signedAsset = (id: string, expiry?: string, signature?: string) => {
    if (!z.string().uuid().safeParse(id).success) throw new DomainError('NOT_FOUND', '音频不存在。', 404);
    service.assets.verify(id, expiry, signature);
    const asset = service.store.speech(service.config.ownerId, id); service.assets.assertPlayable(asset); return asset;
  };
  app.get('/speech/:id', c => {
    const asset = signedAsset(c.req.param('id'), c.req.query('expires'), c.req.query('signature'));
    c.header('Access-Control-Allow-Origin', '*'); return c.json(service.assets.publicResult(asset));
  });
  app.get('/player/:id', c => {
    signedAsset(c.req.param('id'), c.req.query('expires'), c.req.query('signature'));
    return c.html(readFileSync(resolve(service.config.root, 'public/player.html'), 'utf8'));
  });
  app.on(['GET', 'HEAD'], '/audio/:id', c => {
    const asset = signedAsset(c.req.param('id'), c.req.query('expires'), c.req.query('signature'));
    const size = statSync(asset.file_path!).size; const range = c.req.header('Range');
    const headers: Record<string, string> = { 'Content-Type': asset.mime_type!, 'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*', 'Cache-Control': 'private, max-age=0', 'X-Content-Type-Options': 'nosniff' };
    let start = 0, end = size - 1, status = 200;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
      if (!match[1]) { const suffix = Number(match[2]); start = Math.max(0, size - suffix); if (suffix <= 0) start = size; }
      else { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), size - 1); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`; status = 206;
    }
    headers['Content-Length'] = String(end - start + 1);
    const data = c.req.method === 'HEAD' ? null : new Uint8Array(readFileSync(asset.file_path!).subarray(start, end + 1));
    return new Response(data, { status, headers });
  });

  app.use('/mcp', bodyLimit({ maxSize: 512 * 1024 }));
  app.all('/mcp', async c => {
    const authorization = c.req.header('Authorization') || '';
    if (!authorization.startsWith('Bearer ') || !equal(authorization.slice(7), service.config.mcpToken)) throw new DomainError('UNAUTHORIZED', 'MCP 连接需要有效 Bearer Token。', 401);
    const server = createMcpServer(service);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(c.req.raw);
      // JSON responses are complete at this point; no persistent SSE session is advertised.
      return response;
    } finally { await server.close(); }
  });
  return app;
}

export async function startHttp(service: VoiceService, port = service.config.port) {
  const app = createHttpApp(service);
  // A fixed port is nicer for bookmarks but collides when a dev server or a
  // second client already holds it. Fall back to a free port instead of dying:
  // the MCP tools keep working, only the owner URL moves.
  let instance = serve({ fetch: app.fetch, hostname: service.config.host, port });
  try {
    await new Promise<void>((resolvePromise, reject) => {
      if (instance.listening) resolvePromise();
      else { instance.once('listening', resolvePromise); instance.once('error', reject); }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    console.error(`Port ${port} busy; the owner UI moves to a random port for this run.`);
    instance = serve({ fetch: app.fetch, hostname: service.config.host, port: 0 });
    await new Promise<void>((resolvePromise, reject) => {
      if (instance.listening) resolvePromise();
      else { instance.once('listening', resolvePromise); instance.once('error', reject); }
    });
  }
  const address = instance.address();
  if (!address || typeof address === 'string') throw new Error('HTTP address unavailable');
  const host = service.config.host.includes(':') ? `[${service.config.host}]` : service.config.host;
  const localUrl = `http://${host}:${address.port}`;
  service.assets.baseUrl = localUrl;
  const cleanup = setInterval(() => { service.store.recoverStaleSpeech(Math.max(service.config.timeoutMs, service.config.seedAudioTimeoutMs)); service.assets.cleanup(); }, 60000);
  cleanup.unref();
  // Host/port cannot change under a live listener; everything else takes effect
  // immediately, so editing settings.json by hand is enough.
  const watcher = watchSettings(config => {
    if (config.host !== service.config.host || config.port !== service.config.port) {
      console.error('settings: host/port changed; restart to move the listener.');
    }
    service.config = config;
    service.reloadSettings();
  }, error => console.error(`settings: ${error.message}`));
  return { app, instance, localUrl, close: async () => {
    clearInterval(cleanup); watcher.close();
    await new Promise<void>((resolvePromise, reject) => instance.close(error => error ? reject(error) : resolvePromise()));
  } };
}
