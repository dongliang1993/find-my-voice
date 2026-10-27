// The demo keeps a data home of its own, so a recording never touches the
// real conversation, papers or memory. Only the settings are borrowed: the
// voice and keys the user already set up.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const demoHome = () => process.env.FMV_DEMO_HOME || resolve(homedir(), '.find-my-voice-demo');
const realHome = () => process.env.FIND_MY_VOICE_HOME || resolve(homedir(), '.find-my-voice');
/** Takes are kept across fresh starts: they are what the voice script spent time and quota on. */
const KEEP = new Set(['voice-cache', 'config.json']);

export function prepareDemoHome(home: string, { fresh = false } = {}) {
  if (fresh && existsSync(home)) {
    for (const entry of readdirSync(home)) if (!KEEP.has(entry)) rmSync(resolve(home, entry), { recursive: true, force: true });
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const config = resolve(home, 'config.json');
  const real = resolve(realHome(), 'config.json');
  if (!existsSync(config) && existsSync(real) && resolve(real) !== resolve(config)) copyFileSync(real, config);
}
