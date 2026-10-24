// One-shot: pre-generates the onboarding's fixed lines with the configured
// ElevenLabs voice, so the first meeting never synthesizes on the spot.
// Run when SCRIPT changes; the WAVs are committed, CI never calls this.
//
//   npx tsx scripts/pregen-onboarding.mjs
//
// Dynamic lines (the name echoes) are NOT here: they stay on the live path.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadSettings } from '../src/server/config.ts';
import { ElevenLabsProvider } from '../src/server/voice/eleven.ts';

const OUT_DIR = resolve(import.meta.dirname, '../web/public/onboarding');

/**
 * The fixed lines, duplicated here on purpose: this script cannot import the
 * web module (vite aliases do not resolve under node). When either copy
 * changes, update the other and re-run; the manifest below is the diff.
 */
const LINES = {
  wake: "Hi, I'm here.",
  ask_alias: 'What should I call you?',
  comfort_ask: "When you're having a bad day, what do you want me to do?",
  rhythm_ask: 'When do you most want someone to talk to?',
  notes_ask: 'Is anything sitting on your mind lately?',
  name_ask: 'Last thing: what do you want to call me?',
  name_herself: 'Or I could pick one myself.',
  propose_intro: "I've got one.",
  hint_open: 'You can just say it, or type it. Either is fine.',
  hint_choice: "Whichever feels closest. There's no wrong one.",
  hint_notes: "It can be something small. Or skip it, that's fine too.",
  hint_stage: "You can just say it, or type. I'm right here.",
};

const settings = loadSettings();
const eleven = settings.voice.elevenlabs;
if (settings.voice.provider !== 'elevenlabs' || !eleven.apiKey) {
  console.error('把 voice.provider 配成 elevenlabs 并填好 Key 再跑。');
  process.exit(1);
}

const provider = new ElevenLabsProvider({
  apiKey: eleven.apiKey,
  model: eleven.model,
  language: eleven.language,
  stability: eleven.stability,
  similarity: eleven.similarity,
  timeoutMs: 120000,
});

mkdirSync(OUT_DIR, { recursive: true });
let ok = 0;
// `npx tsx scripts/pregen-onboarding.mjs wake` regenerates just the named lines.
const only = new Set(process.argv.slice(2));
for (const [key, text] of Object.entries(LINES)) {
  if (only.size && !only.has(key)) continue;
  // synthesize() always archives as WAV; PCM streaming is the live path only.
  const { audio, mime } = await provider.synthesize(
    { text, voice: { id: eleven.voiceId, resourceId: '' }, speechRate: 0, language: eleven.language },
  );
  writeFileSync(resolve(OUT_DIR, `${key}.wav`), audio);
  console.log(`${key}.wav  ${(audio.length / 1024).toFixed(0)} KiB  ${mime}`);
  ok++;
}
console.log(`\n${ok}/${only.size || Object.keys(LINES).length} 条固定台词已预生成 → ${OUT_DIR}`);
