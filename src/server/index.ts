import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { defaultDataDir, packageRoot } from './config.js';
import { App } from './app.js';
import { createHttp } from './http.js';

const args = new Set(process.argv.slice(2));

function openBrowser(url: string) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const commandArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(command, commandArgs, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

function listen(app: App, port: number) {
  const { http, injectWebSocket } = createHttp(app, resolve(packageRoot, 'dist/web'));
  const server = serve({ fetch: http.fetch, hostname: app.settings.server.host, port }, info => {
    const url = `http://${app.settings.server.host === '::1' ? '[::1]' : app.settings.server.host}:${info.port}`;
    process.stderr.write(`\n  ${app.settings.companion.name} 在这里等你：${url}\n\n`);
    if (!args.has('--no-open')) openBrowser(url);
  });
  injectWebSocket(server);
  return server;
}

const app = new App(defaultDataDir());
// The desktop shell finds a free port itself and passes it here; standalone
// runs keep using the configured one.
const port = Number(process.env.FMV_PORT) || app.settings.server.port;
const server = listen(app, port);
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') process.stderr.write(`端口 ${port} 已被占用。可能已经有一个 find-my-voice 在运行，或在 ~/.find-my-voice/config.json 修改端口。\n`);
  else process.stderr.write(`${error.message}\n`);
  process.exit(1);
});

let closing = false;
const shutdown = async () => {
  // A second Ctrl-C means "now": don't wait for anything.
  if (closing) process.exit(1);
  closing = true;
  server.close();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
