// Her voice in the demo comes from takes made ahead of time, one file per
// sentence the pipeline asks for, so a recording never waits on a provider or
// gets a different reading than the one picked.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PCM_SAMPLE_RATE } from '../../shared/protocol.js';
import { splitSentences } from '../../shared/sentences.js';
import { SPLIT } from '../voice/pipeline.js';
import { pcmToWav, type SynthesisInput, type SynthesisOptions, type SynthesisResult, type TtsProvider } from '../voice/provider.js';

const BYTES_PER_SECOND = PCM_SAMPLE_RATE * 2;
const CHUNK_BYTES = BYTES_PER_SECOND / 5;
/** A guess for a line with no take yet: about how long she takes to say it. */
const MS_PER_CHAR = { zh: 230, en: 65 };

export const demoSentences = (text: string) => splitSentences(text, SPLIT);

/** Turns the take up or down, for the one line she says quieter than the rest. */
export function scaleVolume(pcm: Buffer, volume: number): Buffer {
  if (volume === 1) return pcm;
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i + 1 < pcm.length; i += 2) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i) * volume))), i);
  return out;
}

export class DemoVoice implements TtsProvider {
  constructor(readonly dir: string, private live: () => TtsProvider, private log: (line: string) => void = () => {}) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private path(sentence: string) {
    return resolve(this.dir, `${createHash('sha1').update(sentence.trim()).digest('hex').slice(0, 20)}.pcm`);
  }

  has(sentence: string) { return existsSync(this.path(sentence)); }

  put(sentence: string, pcm: Buffer) {
    // Written aside first, so a take cut off halfway is never played.
    const path = this.path(sentence);
    writeFileSync(`${path}.part`, pcm, { mode: 0o600 });
    renameSync(`${path}.part`, path);
  }

  private letterPath(paragraphs: string[]) { return this.path(`letter\n${paragraphs.join('\n')}`); }

  /** Her reading of a whole letter, as one take: it is played as written, not sentence by sentence. */
  letter(paragraphs: string[]): Buffer | null {
    const path = this.letterPath(paragraphs);
    return existsSync(path) ? readFileSync(path) : null;
  }

  putLetter(paragraphs: string[], pcm: Buffer) {
    const path = this.letterPath(paragraphs);
    writeFileSync(`${path}.part`, pcm, { mode: 0o600 });
    renameSync(`${path}.part`, path);
  }

  /** How long the whole line plays, from its takes; guessed for any sentence without one. */
  durationMs(text: string): number {
    return demoSentences(text).reduce((sum, sentence) => sum + this.sentenceMs(sentence), 0);
  }

  // Never split again: the first piece of a line is cut shorter, so a sentence split on its own comes out different.
  private sentenceMs(sentence: string) {
    const path = this.path(sentence);
    if (existsSync(path)) return (readFileSync(path).length / BYTES_PER_SECOND) * 1000;
    return [...sentence].length * (/[一-鿿]/u.test(sentence) ? MS_PER_CHAR.zh : MS_PER_CHAR.en);
  }

  /** How far into the line `through` has been said, end included. */
  offsetMs(text: string, through: string): number {
    const found = text.indexOf(through);
    if (found === -1) return 0;
    const target = found + through.length;
    let cursor = 0;
    let ms = 0;
    for (const sentence of demoSentences(text)) {
      const at = text.indexOf(sentence, cursor);
      cursor = (at === -1 ? cursor : at) + sentence.length;
      ms += this.sentenceMs(sentence);
      if (cursor >= target) break;
    }
    return ms;
  }

  async synthesize(input: SynthesisInput, options: SynthesisOptions = {}): Promise<SynthesisResult> {
    const path = this.path(input.text);
    if (!existsSync(path)) {
      this.log(`[demo] no take for "${input.text}"; synthesizing live and keeping it`);
      const pcm: Buffer[] = [];
      const result = await this.live().synthesize(input, {
        ...options, format: 'pcm',
        onAudioChunk: async chunk => { pcm.push(chunk); await options.onAudioChunk?.(chunk); },
      });
      this.put(input.text, Buffer.concat(pcm));
      return result;
    }
    const pcm = readFileSync(path);
    for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
      options.signal?.throwIfAborted();
      await options.onAudioChunk?.(pcm.subarray(offset, offset + CHUNK_BYTES));
    }
    return { audio: pcmToWav(pcm, PCM_SAMPLE_RATE), extension: 'wav', mime: 'audio/wav', durationSeconds: pcm.length / BYTES_PER_SECOND };
  }
}
