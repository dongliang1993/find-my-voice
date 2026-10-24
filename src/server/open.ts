import { spawn } from 'node:child_process';

/**
 * Opens a URL in the user's own browser (or the app that claims it — Apple
 * Maps for a maps link). The URL is passed as an argument, never through a
 * shell: `cmd /c start` would read the `&` in a query string as a second
 * command, so Windows goes through the protocol handler instead.
 */
export function openExternal(url: string) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  spawn(command, args as string[], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}
