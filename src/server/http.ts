import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { createNodeWebSocket } from '@hono/node-ws';
import { z } from 'zod';
import type { ServerEvent } from '../shared/protocol.js';
import { clientEventSchema } from './chat/client-events.js';
import { maskSettings, settingsPatchSchema } from './config.js';
import { DomainError, errorPayload } from './errors.js';
import type { App } from './app.js';

/** Ten seconds of compressed speech is tens of KB; this leaves room and no more. */
const MAX_CLIP_BYTES = 2 * 1024 * 1024;

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

  // Onboarding: progress, drafts and scripted lines. One guard at the door:
  // once onboarding is complete, these endpoints answer with its final state
  // and refuse to run anything.
  http.get('/api/onboarding', c => c.json(app.onboarding()));
  http.put('/api/onboarding', async c => {
    const body = z.object({
      step: z.number().int().min(0).max(7),
      draft: z.record(z.string(), z.unknown()).default({}),
      completed: z.boolean().default(false),
    }).parse(await c.req.json());
    if (app.onboarding().completedAt) return c.json(app.onboarding());
    app.saveOnboarding(body.step, body.draft, body.completed);
    return c.json(app.onboarding());
  });
  http.post('/api/onboarding/say', async c => {
    const body = z.object({
      text: z.string().trim().min(1).max(500),
      speak: z.boolean().default(false),
    }).parse(await c.req.json());
    if (app.onboarding().completedAt) return c.json({ code: 'ONBOARDING_DONE', message: '引导已经结束了。' }, 409);
    const { messageId, audioId } = app.narrate(body.text, { speak: body.speak });
    return c.json({ messageId, audioId, spoken: audioId !== null });
  });
  http.post('/api/onboarding/propose-name', async c => {
    const body = z.object({
      alias: z.string().trim().max(40).default(''),
      notes: z.string().trim().max(2000).default(''),
    }).parse(await c.req.json());
    try {
      return c.json(await app.proposeName(body.alias, body.notes) ?? { name: null });
    } catch (error) {
      if (error instanceof DomainError) return c.json(errorPayload(error), error.httpStatus as 400);
      app.log(`propose-name failed: ${(error as Error).stack ?? error}`);
      return c.json({ code: 'NAMING_FAILED', message: '这次没成，再试一次或直接输入一个名字。' }, 502);
    }
  });
  // The spoken answer to "what should I call you". Raw audio body; small on
  // purpose — a name takes seconds, and the page stops recording at 8.
  http.post('/api/onboarding/hear-alias', async c => {
    const mime = (c.req.header('content-type') ?? '').split(';')[0]!.trim();
    if (!/^audio\/[\w.+-]+$/.test(mime)) return c.json({ code: 'INVALID_INPUT', message: '需要一段录音。' }, 415);
    const length = Number(c.req.header('content-length') ?? 0);
    if (length > MAX_CLIP_BYTES) return c.json({ code: 'CLIP_TOO_LARGE', message: '录音太长了。' }, 413);
    const audio = Buffer.from(await c.req.arrayBuffer());
    // A body without Content-Length is only measured once read.
    if (audio.length > MAX_CLIP_BYTES) return c.json({ code: 'CLIP_TOO_LARGE', message: '录音太长了。' }, 413);
    if (!audio.length) return c.json({ code: 'INVALID_INPUT', message: '录音是空的。' }, 400);
    try {
      return c.json(await app.hearAlias(audio, mime));
    } catch (error) {
      if (error instanceof DomainError) return c.json(errorPayload(error), error.httpStatus as 400);
      app.log(`hear-alias failed: ${(error as Error).stack ?? error}`);
      return c.json({ code: 'HEAR_FAILED', message: '没听清，可以再说一次，或者打字告诉我。' }, 502);
    }
  });
  http.post('/api/onboarding/finish', async c => {
    const body = z.object({
      alias: z.string().trim().min(1).max(40),
      companionName: z.string().trim().min(1).max(40),
      nameOrigin: z.string().trim().min(1).max(500),
      notes: z.string().trim().max(2000).default(''),
      comfort: z.enum(['listen', 'advise', 'cheer', 'depends']).default('depends'),
      rhythm: z.enum(['morning', 'commute', 'night', 'anytime']).default('anytime'),
    }).parse(await c.req.json());
    try {
      await app.finishOnboarding(body);
      return c.json(app.onboarding());
    } catch (error) {
      if (error instanceof DomainError) return c.json(errorPayload(error), error.httpStatus as 400);
      app.log(`finish onboarding failed: ${(error as Error).stack ?? error}`);
      return c.json({ code: 'FINISH_FAILED', message: '没保存上，再试一次。' }, 500);
    }
  });

  http.get('/api/settings', c => c.json(maskSettings(app.settings)));
  http.patch('/api/settings', async c => {
    // Secrets may be cleared with "" but are otherwise only ever written, never read back.
    const patch = settingsPatchSchema.parse(await c.req.json());
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
    const viewer = Symbol('viewer');
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
        else if (message.type === 'presence') app.presence.set(viewer, message.visible);
        else void app.chat.interrupt();
      },
      onClose() { unsubscribe(); app.presence.delete(viewer); },
    };
  }));

  // The built web app. In development Vite serves it and proxies /api here.
  if (existsSync(resolve(webRoot, 'index.html'))) {
    http.use('/*', serveStatic({ root: webRoot }));
    http.get('*', serveStatic({ path: resolve(webRoot, 'index.html') }));
  }

  return { http, injectWebSocket };
}
