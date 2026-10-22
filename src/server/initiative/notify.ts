import { execFile } from 'node:child_process';

/**
 * A system notification, so she can reach you when the page is closed or in the
 * background. macOS only (osascript, no dependencies); elsewhere a no-op.
 * Text goes in as an argument, never spliced into the script, so quotes in
 * what she says cannot break or inject AppleScript.
 */
export function notifySystem(title: string, body: string, onError?: (error: Error) => void) {
  if (process.platform !== 'darwin') return;
  const script = 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run';
  execFile('osascript', ['-e', script, title, body.slice(0, 200)], { timeout: 5000 }, error => {
    if (error) onError?.(error);
  });
}
