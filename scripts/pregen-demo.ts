// Makes her takes for the demo once, with the configured voice, so the
// recording plays them instead of synthesizing live. Run it again to try a
// line once more until the reading is the one you want.
//
//   npm run demo:voice -- --name 东亮              every line that has no take yet
//   npm run demo:voice -- --name 东亮 brave        again: lines containing "brave"
//   npm run demo:voice -- --name 东亮 --force      again: every line
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PCM_SAMPLE_RATE } from '../src/shared/protocol.ts';
import { loadSettings } from '../src/server/config.ts';
import { demoHome, prepareDemoHome } from '../src/server/demo/home.ts';
import { herLines, letters, loadDemo } from '../src/server/demo/script.ts';
import { DemoVoice, demoSentences, scaleVolume } from '../src/server/demo/voice.ts';
import { activeVoice, createTtsProvider, voiceReady } from '../src/server/voice/registry.ts';
import { COMFORT_LABELS, RHYTHM_LABELS, SCRIPT } from '../web/src/features/onboarding/script.ts';

const { values, positionals } = parseArgs({
  // pnpm hands the `--` separator through; npm does not.
  args: process.argv.slice(2).filter(arg => arg !== '--'),
  allowPositionals: true,
  options: { name: { type: 'string' }, force: { type: 'boolean' }, script: { type: 'string' } },
});
const home = demoHome();
prepareDemoHome(home);
const settings = loadSettings(home);
const name = values.name || settings.companion.userName;
if (!name) { console.error('告诉我你的名字：npm run demo:voice -- --name <名字>'); process.exit(1); }
if (!voiceReady(settings.voice)) { console.error(`还没有配置语音（${home}/config.json）。`); process.exit(1); }

const demo = loadDemo(resolve(values.script ?? 'scripts/demo.json'), name);
const { herName, onboardingAnswers: { comfort, rhythm } } = demo.preset;
// The first meeting's own lines that carry a name or an answer; the rest are fixed audio already.
const meeting = [
  SCRIPT.nameEcho(name), SCRIPT.comfortEcho(COMFORT_LABELS[comfort]), SCRIPT.rhythmEcho(RHYTHM_LABELS[rhythm]),
  SCRIPT.notesEcho, SCRIPT.finalEcho(name, herName), SCRIPT.arrival(name, rhythm),
].map(text => ({ text, volume: undefined, rate: undefined }));
const lines = [...meeting, ...herLines(demo)];

const provider = createTtsProvider(settings.voice);
const voice = new DemoVoice(resolve(home, 'voice-cache'), () => provider);
const picked = (text: string) => positionals.some(p => text.toLowerCase().includes(p.toLowerCase()));

const read = async (text: string, rate?: number) => {
  const pcm: Buffer[] = [];
  await provider.synthesize(
    { text, voice: activeVoice(settings.voice), speechRate: rate ?? settings.voice.speechRate, language: /[一-鿿]/u.test(text) ? 'zh' : 'en' },
    { format: 'pcm', onAudioChunk: async chunk => { pcm.push(chunk); } },
  );
  return Buffer.concat(pcm);
};
/** The breath between a letter's paragraphs: she reads it as written, not as one run-on line. */
const PARAGRAPH_PAUSE = Buffer.alloc(Math.round(PCM_SAMPLE_RATE * 0.8) * 2);

let made = 0;
for (const line of lines) {
  const again = values.force || picked(line.text);
  if (positionals.length && !again) continue;
  for (const sentence of demoSentences(line.text)) {
    if (voice.has(sentence) && !again) continue;
    voice.put(sentence, scaleVolume(await read(sentence, line.rate), line.volume ?? 1));
    made++;
    console.log(`✓ ${sentence}`);
  }
}
for (const letter of letters(demo)) {
  const again = values.force || picked(letter.id) || letter.paragraphs.some(picked);
  if (positionals.length && !again) continue;
  if (voice.letter(letter.paragraphs) && !again) continue;
  const takes: Buffer[] = [];
  for (const paragraph of letter.paragraphs) takes.push(await read(paragraph));
  voice.putLetter(letter.paragraphs, Buffer.concat(takes.flatMap((take, i) => (i ? [PARAGRAPH_PAUSE, take] : [take]))));
  made++;
  console.log(`✓ 信：${letter.paragraphs[0]}…`);
}
console.log(made ? `\n${made} 句，存在 ${voice.dir}` : '都有了。要重做某一句：npm run demo:voice -- --name <名字> <句子里的几个字>');
