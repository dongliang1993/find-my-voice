// Where an item on a letter opens. The model names the thing and its kind;
// the URL is always built here, from an allowlist — it never writes one, and
// nothing a letter carries can send the browser anywhere else.

import type { LetterLink, LetterLinkKind } from './protocol.js';

const SEARCH: Record<LetterLinkKind, (query: string) => string> = {
  movie: q => `https://search.douban.com/movie/subject_search?search_text=${encodeURIComponent(q)}`,
  book: q => `https://search.douban.com/book/subject_search?search_text=${encodeURIComponent(q)}`,
  music: q => `https://music.163.com/#/search/m/?s=${encodeURIComponent(q)}&type=1`,
  place: q => `https://maps.apple.com/?q=${encodeURIComponent(q)}`,
  web: q => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
};

export const LINK_KINDS = Object.keys(SEARCH) as LetterLinkKind[];

export function linkUrl({ kind, query }: LetterLink): string {
  return SEARCH[kind](query.trim());
}
