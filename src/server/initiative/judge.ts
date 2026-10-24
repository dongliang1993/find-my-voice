import { z } from 'zod';
import type { ChatMessage } from '../../shared/protocol.js';
import type { Candidate } from './gate.js';

/**
 * The judge's answer, and it is deliberately all it can say. Not "what should
 * I say" — that is the persona's job, and asking the persona whether it wants
 * to talk is how a companion turns into a push notification. This call only
 * decides whether the moment is worth anything, and what it is about.
 */
export const judgementSchema = z.object({
  speak: z.boolean(),
  /** One line naming the thing: what she would be asking about, in her own words. */
  subject: z.string().trim().max(120).default(''),
  /** Why now, for the log — never shown to the user. */
  reason: z.string().trim().max(200).default(''),
});
export type Judgement = z.infer<typeof judgementSchema>;
export type JudgementInput = z.input<typeof judgementSchema>;

export type JudgeContext = {
  candidate: Candidate;
  /** The tail of the conversation, oldest first. */
  recent: ChatMessage[];
  companionName: string;
  now: Date;
};

const speaker = (m: ChatMessage) => (m.role === 'user' ? '对方' : '你');

/**
 * What the judge is told about each kind of reason, and the one test that
 * matters for it. Each kind fails differently: a follow-up goes stale, an echo
 * goes false, a greeting goes hollow.
 */
const KINDS: Record<Candidate['kind'], { why: string; test: string }> = {
  followup: {
    why: '你之前记下要关心的一件事。',
    test: '如果最近的聊天里对方已经说了结果、已经聊过这件事，就不要说。',
  },
  echo: {
    why: '对方说过的一句话一直留在你心里。',
    test: '只有这句话真的值得回味（一个画面、一个有意思的说法），而且之后没再聊过，才说。'
      + '如果它关于对方的痛苦、隐私或难过的事，不要主动提起；如果说出来会像在翻旧账或者表演"我很懂你"，也不要说。',
  },
  rhythm: {
    why: '现在是对方平时愿意聊天的时段。',
    test: '这是最轻的一种开口。如果对方今天有具体的安排，就挂在那件事上；没有的话，一句轻轻的问候也可以，但不要假装有什么事。',
  },
};

/**
 * A cheap, persona-free pass over "is this worth saying". The default is no:
 * most ticks have nothing behind them, and a companion who speaks because it
 * is her turn is a notification, not a presence.
 */
export function buildJudgePrompt({ candidate, recent, companionName, now }: JudgeContext): string {
  const transcript = recent.length
    ? recent.map(m => `[${new Date(m.createdAt).toLocaleString('zh-CN', { hour12: false })}] ${speaker(m)}：${m.text}`).join('\n')
    : '（还没有聊过）';
  const kind = KINDS[candidate.kind];
  return `你在判断「${companionName}」现在要不要主动找对方说一句话。你不是在写这句话，只判断值不值得说。

现在是 ${now.toLocaleString('zh-CN', { dateStyle: 'full', timeStyle: 'short', hour12: false })}。

# 为什么会想到找对方
${kind.why}${candidate.reason}

# 最近的聊天
${transcript}

# 怎么判断
- 默认是不说。只有这件事在现在看来依然有意义、对方会愿意收到，才说。
- ${kind.test}
- 如果对方最近正在忙、情绪不好、或者刚道过别，就不要说。
- 不要因为「很久没聊了」而说。沉默本身不是理由。

返回 speak（要不要说）、subject（如果要说，一句话说明是什么事，不要写成完整的消息）、reason（一两句，为什么现在说）。`;
}
