import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { createNodeWebSocket } from '@hono/node-ws';
import { z } from 'zod';
import type { ServerEvent } from '../shared/protocol.js';
import { clientEventSchema } from './chat/client-events.js';
import { maskSettings, settingsSchema, type SettingsPatch } from './config.js';
import { DomainError, errorPayload } from './errors.js';
import type { App } from './app.js';

// Secrets may be cleared with "" but are otherwise only ever written, never read back.
const patchSchema = z.object({
  companion: settingsSchema.shape.companion.unwrap().partial().optional(),
  brain: settingsSchema.shape.brain.unwrap().partial().optional(),
  voice: settingsSchema.shape.voice.unwrap().partial().optional(),
}).strict();

export function createHttp(app: App, webRoot: string) {
  const http = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app: http });

  // Only this machine's own pages may call the API (blocks DNS-rebinding and cross-site requests).
  http.use('/api/*', async (c, next) => {
    const host = c.req.header('host') ?? '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return c.json({ code: 'FORBIDDEN', message: 'Forbidden host' }, 403);
    const origin = c.req.header('origin');
    if (origin && new URL(origin).host !== host) return c.json({ code: 'FORBIDDEN', message: 'Forbidden origin' }, 403);
    // <audio src> from another site sends no Origin; the browser still labels it cross-site.
    if (c.req.header('sec-fetch-site') === 'cross-site') return c.json({ code: 'FORBIDDEN', message: 'Forbidden site' }, 403);
    await next();
  });

  http.onError((error, c) => {
    if (!(error instanceof DomainError)) app.log(`http error: ${error.stack ?? error}`);
    const status = error instanceof DomainError ? error.httpStatus : error instanceof z.ZodError ? 400 : 500;
    const body = error instanceof z.ZodError ? { code: 'INVALID_INPUT', message: '参数无效' } : errorPayload(error);
    return c.json(body, status as 400);
  });

  http.get('/api/status', c => c.json(app.status()));

  http.get('/api/settings', c => c.json(maskSettings(app.settings)));
  http.patch('/api/settings', async c => {
    const patch = patchSchema.parse(await c.req.json()) as SettingsPatch;
    return c.json(maskSettings(await app.updateSettings(patch)));
  });

  http.get('/api/audio/:id', async c => {
    let path: string;
    try { path = app.voice.pathFor(c.req.param('id')); }
    catch { return c.json({ code: 'NOT_FOUND', message: '语音不存在' }, 404); }
    if (!existsSync(path)) return c.json({ code: 'NOT_FOUND', message: '语音不存在' }, 404);
    return c.body(await readFile(path), 200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'private, max-age=31536000, immutable' });
  });

  http.get('/api/ws', upgradeWebSocket(c => {
    const origin = c.req.header('origin');
    const host = c.req.header('host');
    let unsubscribe = () => {};
    return {
      onOpen(_event, ws) {
        if (origin && host && new URL(origin).host !== host) { ws.close(1008, 'Forbidden origin'); return; }
        const send = (event: ServerEvent) => ws.send(JSON.stringify(event));
        send(app.chat.snapshot());
        unsubscribe = app.chat.subscribe(send);
      },
      onMessage(event, ws) {
        let parsed;
        try { parsed = clientEventSchema.safeParse(JSON.parse(String(event.data))); }
        catch { parsed = null; }
        if (!parsed?.success) {
          ws.send(JSON.stringify({ type: 'error', code: 'INVALID_EVENT', message: '无法识别的消息' } satisfies ServerEvent));
          return;
        }
        const message = parsed.data;
        if (message.type === 'send') void app.chat.send(message.clientId, message.text);
        else void app.chat.interrupt();
      },
      onClose() { unsubscribe(); },
    };
  }));

  // The built web app. In development Vite serves it and proxies /api here.
  if (existsSync(resolve(webRoot, 'index.html'))) {
    http.use('/*', serveStatic({ root: webRoot }));
    http.get('*', serveStatic({ path: resolve(webRoot, 'index.html') }));
  }

  return { http, injectWebSocket };
}
