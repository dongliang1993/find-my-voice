// Starts the app in demo mode, for recording the walkthrough: her part comes
// from scripts/demo.json, in a data home of its own.
//
//   npm run demo -- --name 东亮            resume where the last run left off
//   npm run demo -- --name 东亮 --fresh    start over from the first meeting
//   npm run demo -- --name 东亮 --web      in the browser instead of the desktop window
//
// Keys in the page: → next, ← back one step, ⌥R the scene again, ⌥1–⌥5 a scene.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadSettings } from '../src/server/config.ts';
import { demoHome, prepareDemoHome } from '../src/server/demo/home.ts';
import { herLines, letters, loadDemo } from '../src/server/demo/script.ts';
import { DemoVoice, demoSentences } from '../src/server/demo/voice.ts';
import { createTtsProvider } from '../src/server/voice/registry.ts';

const { values } = parseArgs({
  // pnpm hands the `--` separator through; npm does not.
  args: process.argv.slice(2).filter(arg => arg !== '--'), options: { name: { type: 'string' }, fresh: { type: 'boolean' }, web: { type: 'boolean' }, script: { type: 'string' } } });
const home = demoHome();
prepareDemoHome(home, { fresh: values.fresh });
const name = values.name || loadSettings(home).companion.userName;
if (!name) {
  process.stderr.write('告诉我你的名字：npm run demo -- --name <名字>\n');
  process.exit(1);
}
const script = resolve(values.script ?? 'scripts/demo.json');
const demo = loadDemo(script, name);

const voice = new DemoVoice(resolve(home, 'voice-cache'), () => createTtsProvider(loadSettings(home).voice));
const missing = herLines(demo).filter(line => demoSentences(line.text).some(sentence => !voice.has(sentence)));
const unread = letters(demo).filter(letter => !voice.letter(letter.paragraphs));
if (missing.length) process.stderr.write(`\n  还有 ${missing.length} 句没有预生成的语音，会现场合成。先跑：npm run demo:voice -- --name ${name}\n`);
if (unread.length) process.stderr.write(`\n  还有 ${unread.length} 封信没有朗读，信上不会有播放按钮。先跑：npm run demo:voice -- --name ${name}\n`);
process.stderr.write(`\n  演示模式 · ${home}\n  → 下一步  ← 退一步  ⌥R 本场重来  ⌥1–⌥5 跳到某一场\n\n`);

// The desktop window by default, as it is recorded; Tauri's beforeDevCommand runs the server and Vite with this env.
const [command, args] = values.web ? ['node', ['scripts/dev.mjs']] : ['cargo', ['tauri', 'dev']];
const child = spawn(command, args, {
  stdio: 'inherit',
  env: { ...process.env, FIND_MY_VOICE_HOME: home, FMV_DEMO: script, FMV_DEMO_NAME: name },
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 0));
