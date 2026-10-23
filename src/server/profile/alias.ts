import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { BrainAuth } from '../brain/auth.js';

/**
 * What the user wants to be called, pulled out of what they said aloud.
 * People rarely answer "what should I call you" with the bare name: they say
 * "叫我阿良就行" or "嗯……阿良吧". A bare name skips the model entirely.
 */
export const aliasSchema = z.object({
  /** null when nothing in the answer is a name, e.g. noise or "我不知道". */
  alias: z.string().trim().min(1).max(12).nullable(),
});
export type AliasResult = z.infer<typeof aliasSchema>;

/** Trailing punctuation the transcriber adds to a one-word answer. */
const TRAILING = /[\s。．.，,！!？?…~～]+$/u;
/** A Latin name: one word, letters only. */
const LATIN_NAME = /^[A-Za-z][A-Za-z'-]{0,15}$/;
/**
 * A Chinese name: up to four characters with none of the words people wrap a
 * name in. CJK has no spaces, so "叫我阿良就行" would otherwise pass as a word.
 */
const CJK_NAME = /^[\p{Script=Han}·]{1,4}$/u;
const WRAPPING = /[叫我是就行吧呢啊嗯哦呀的你]/u;

export function plainAlias(said: string): string | null {
  const text = said.trim().replace(TRAILING, '');
  if (LATIN_NAME.test(text)) return text;
  if (CJK_NAME.test(text) && !WRAPPING.test(text)) return text;
  return null;
}

export function aliasPrompt(said: string): string {
  return `对方被问到"该怎么称呼你？"，用语音回答了下面这句话（语音识别结果，可能有错字或语气词）：

「${said}」

从中取出对方希望被怎么称呼。只要称呼本身，去掉"叫我""就行""吧"之类的话和语气词。对方给了全名又给了昵称时，取对方说"叫我"的那个。如果这句话里没有可以当称呼的词，返回 null。`;
}

/** One throwaway agent with structured output, isolated like the naming step. */
export async function extractAliasWithClaude(auth: BrainAuth, dataDir: string, said: string, onLog?: (line: string) => void): Promise<string | null> {
  const workspace = resolve(dataDir, 'workspace');
  const configDir = resolve(dataDir, 'claude');
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  mkdirSync(configDir, { recursive: true, mode: 0o700 });

  const session = query({
    prompt: aliasPrompt(said),
    options: {
      systemPrompt: '你只负责从一句话里取出称呼。只输出结构化结果。',
      model: auth.model,
      env: { ...auth.env, CLAUDE_CONFIG_DIR: configDir },
      cwd: workspace,
      settingSources: [],
      tools: [],
      permissionMode: 'dontAsk',
      thinking: { type: 'disabled' },
      persistSession: false,
      maxTurns: 3,
      // The CLI validates schemas as draft-07; zod defaults to 2020-12, which it rejects.
      outputFormat: { type: 'json_schema', schema: z.toJSONSchema(aliasSchema, { target: 'draft-7' }) as Record<string, unknown> },
      stderr: line => onLog?.(line),
    },
  });
  for await (const message of session) {
    if (message.type !== 'result') continue;
    if (message.subtype !== 'success') throw new Error(`alias extraction ended: ${message.subtype}`);
    if (message.structured_output === undefined) throw new Error('alias extraction returned no structured output');
    return aliasSchema.parse(message.structured_output).alias;
  }
  throw new Error('alias extraction produced no result');
}
