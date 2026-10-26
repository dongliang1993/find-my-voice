import { create } from 'zustand';

/**
 * The language the app's own words are in: the system's by default, held
 * by the 外观 setting. Her reply language is a setting about her, not about
 * the buttons around her.
 */
export type Ui = 'zh' | 'en';
/** The same words in both languages. */
export type Said = Record<Ui, string>;

const SYSTEM: Ui = typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';

type Locale = {
  /** The words' language, resolved: `auto` never leaves the setting. */
  ui: Ui;
  /** Set from the 外观 page; a failed save leaves the words as they were. */
  setLanguage: (language: 'auto' | 'zh' | 'en') => void;
};

export const useLocale = create<Locale>()(set => ({
  ui: SYSTEM,
  setLanguage: language => {
    const ui = language === 'auto' ? SYSTEM : language;
    // `:lang(zh)` in the stylesheet turns the italics off for Chinese;
    // the attribute is what says which language the words are in.
    if (typeof document !== 'undefined') document.documentElement.lang = ui === 'zh' ? 'zh-CN' : 'en';
    set({ ui });
  },
}));

export const useUi = (): Ui => useLocale(store => store.ui);

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

/** 「16:12」 or 「4:12 PM」. */
export const timeOf = (iso: string, ui: Ui) =>
  new Date(iso).toLocaleTimeString(ui === 'zh' ? 'zh-CN' : 'en-US', { hour: 'numeric', minute: '2-digit' });

/** The app's own words, in both languages. */
export const WORDS = {
  home: { zh: '对话', en: 'Talk' },
  papers: { zh: 'Papers', en: 'Papers' },
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
  appearance: { zh: '外观', en: 'Appearance' },
  unset: { zh: '未配置', en: 'Not set up' },
  noPapers: { zh: '还没有存下的东西。她写下的，想留着就存进来。', en: 'Nothing saved yet. What she writes down, keep it here.' },
  untitled: { zh: '无题', en: 'Untitled' },
  writing: { zh: '正在写', en: 'Writing' },
  deletePaper: { zh: '从 Papers 删掉？', en: 'Delete from Papers?' },
  keep: { zh: '留着', en: 'Keep' },
  delete: { zh: '删掉', en: 'Delete' },
  save: { zh: '保存', en: 'Save' },
  today: { zh: '今天', en: 'Today' },
  yesterday: { zh: '昨天', en: 'Yesterday' },
  toStage: { zh: '放回舞台', en: 'Put on the stage' },
  copy: { zh: '复制', en: 'Copy' },
  copied: { zh: '已复制', en: 'Copied' },
} as const satisfies Record<string, Said>;

export type Word = keyof typeof WORDS;
export const useWords = () => {
  const ui = useUi();
  return (word: Word) => WORDS[word][ui];
};
