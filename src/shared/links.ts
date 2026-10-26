// Where an item on a paper opens. The model names the thing and its kind;
// the URL is always built here, from an allowlist — it never writes one, and
// nothing a paper carries can send the browser anywhere else.

import type { PaperLink, PaperLinkKind } from './protocol.js';

const SEARCH: Record<PaperLinkKind, (query: string) => string> = {
  movie: q => `https://search.douban.com/movie/subject_search?search_text=${encodeURIComponent(q)}`,
  book: q => `https://search.douban.com/book/subject_search?search_text=${encodeURIComponent(q)}`,
  music: q => `https://music.163.com/#/search/m/?s=${encodeURIComponent(q)}&type=1`,
  place: q => `https://maps.apple.com/?q=${encodeURIComponent(q)}`,
  web: q => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
};

export const LINK_KINDS = Object.keys(SEARCH) as PaperLinkKind[];

export function linkUrl({ kind, query }: PaperLink): string {
  return SEARCH[kind](query.trim());
}
