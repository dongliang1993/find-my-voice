import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { BrainAuth } from '../brain/auth.js';
import { extractionSchema, type Extraction } from './extractor.js';

/**
 * Runs one memory extraction as a throwaway agent with structured output. Isolated
 * like the chat brain (no user settings, no tools) and never persisted as a session,
 * so it cannot leak into or be resumed by the conversation.
 */
export async function extractWithClaude(auth: BrainAuth, dataDir: string, prompt: string, onLog?: (line: string) => void): Promise<Extraction> {
  const workspace = resolve(dataDir, 'workspace');
  const configDir = resolve(dataDir, 'claude');
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  mkdirSync(configDir, { recursive: true, mode: 0o700 });

  const session = query({
    prompt,
    options: {
      systemPrompt: '你是一个细心的记录者，只根据给定聊天内容提取信息，不编造。',
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
      outputFormat: { type: 'json_schema', schema: z.toJSONSchema(extractionSchema, { target: 'draft-7' }) as Record<string, unknown> },
      stderr: line => onLog?.(line),
    },
  });
  for await (const message of session) {
    if (message.type !== 'result') continue;
    if (message.subtype !== 'success') throw new Error(`memory extraction ended: ${message.subtype}`);
    if (message.structured_output === undefined) throw new Error('memory extraction returned no structured output');
    return extractionSchema.parse(message.structured_output);
  }
  throw new Error('memory extraction produced no result');
}
