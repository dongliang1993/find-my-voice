import { z } from 'zod';

/**
 * One name proposal from the model: a name and why. The proposal is what the
 * onboarding flow shows; the reason becomes the name's origin story, so it
 * must come from the model, not from a template.
 */
export const proposalSchema = z.object({
  /** Short, speakable in the chosen voice, English by preference, not an existing assistant's name. */
  name: z.string().trim().min(1).max(8),
  /** Must tie back to what the user actually said; enforced by prompt and checked by tests. */
  reason: z.string().trim().min(1).max(120),
});
export type Proposal = z.infer<typeof proposalSchema>;

/** Existing assistant names and the lazy "小X" pattern are off the table. */
const BANNED = /^samantha|siri|alexa|cortana|jarvis/i;
const LAZY = /^小./;

export function proposalPrompt(userAlias: string, notes: string): string {
  return `你在给一个 AI 伴侣起她自己的名字。她马上要开始和对方长期相处，这是她的自我叙事的第一页。

对方告诉她的情况：
${notes || '（还没有说过什么）'}

起名规则，全部是硬约束：
1. 优先起英文名，一到两个音节，短、好念。整个对话的开场都是英文，名字也该落在同一种语感里。
2. 英文名也要在中文语音合成里念得出来，不用生僻拼写或需要特殊语调的词。
3. 不用现成 AI 助手的名字（比如 Samantha、Siri、Alexa），不用"小X"这种模板。
4. 理由必须真的和对方说过的情况有关，一句话说清楚，不许套话。

对方怎么称呼自己：${userAlias || '（还没说）'}。名字可以呼应这一点，也可以完全另起，只要理由说得通。`;
}

/** Filters what the model produced before it ever reaches the screen. */
export function acceptable(proposal: Proposal): string | null {
  if (BANNED.test(proposal.name) || LAZY.test(proposal.name)) return null;
  return proposal.name;
}
