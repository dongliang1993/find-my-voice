/**
 * The language the app's own words are in: always the system's. Her reply
 * language is a setting about her, not about the buttons around her.
 */
export type Ui = 'zh' | 'en';
/** The same words in both languages. */
export type Said = Record<Ui, string>;

const SYSTEM: Ui = typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';

export const useUi = (): Ui => SYSTEM;

/** A one-off pair of words, where a shared entry in WORDS would not be reused. */
export const useSay = () => {
  const ui = useUi();
  return (zh: string, en: string) => (ui === 'zh' ? zh : en);
};

/** 「10月24日」 or 「Oct 24」; with the year for a letter's own heading. */
export const dayOf = (iso: string, ui: Ui, withYear = false) =>
  new Date(iso).toLocaleDateString(ui === 'zh' ? 'zh-CN' : 'en-US', {
    month: ui === 'zh' ? 'long' : 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}),
  });

/** The app's own words, in both languages. */
export const WORDS = {
  home: { zh: '对话', en: 'Talk' },
  inbox: { zh: '信箱', en: 'Letters' },
  settings: { zh: '设置', en: 'Settings' },
  close: { zh: '关闭', en: 'Close' },
  history: { zh: '历史', en: 'History' },
  replay: { zh: '再说一遍', en: 'Say it again' },
  pause: { zh: '暂停', en: 'Pause' },
  resume: { zh: '继续', en: 'Go on' },
  tellHer: { zh: '这些也可以直接告诉她', en: 'You can also just tell her' },
  saved: { zh: '已保存', en: 'Saved' },
  brain: { zh: '大脑', en: 'Mind' },
  voice: { zh: '声音', en: 'Voice' },
  unset: { zh: '未配置', en: 'Not set up' },
  noLetters: { zh: '还没有信。她写给你的东西，会收在这里。', en: 'No letters yet. What she writes you is kept here.' },
  aLetter: { zh: '一封信', en: 'A letter' },
  writing: { zh: '正在写', en: 'Writing' },
  unfinished: { zh: '没写完', en: 'Unfinished' },
  deleteLetter: { zh: '删掉这封信？', en: 'Delete this letter?' },
  keep: { zh: '留着', en: 'Keep' },
  delete: { zh: '删掉', en: 'Delete' },
  file: { zh: '收进信箱', en: 'Keep with letters' },
  fold: { zh: '收起', en: 'Put away' },
} as const satisfies Record<string, Said>;

export type Word = keyof typeof WORDS;
export const useWords = () => {
  const ui = useUi();
  return (word: Word) => WORDS[word][ui];
};
