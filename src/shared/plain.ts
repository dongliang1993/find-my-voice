// Her words as plain speech. She is asked not to format anything, and mostly
// does not — but a model asked for "five rainy-day films" reaches for a list,
// and now and then for HTML. On a stage that reads one line at a time, and in
// a voice that reads everything aloud, markup is noise: `<p>` on screen, "star
// star" in her mouth. This is the net under the prompt, not instead of it.
//
// Shared: the server cleans what it stores and what it speaks; the page cleans
// what it is still streaming in, since a reply is shown before it is stored.

/** Tags that end a block of text; they become a line break so the words do not run together. */
const BLOCK_TAG = /<\/?(?:p|div|br|li|ul|ol|h[1-6]|blockquote|tr|table)\b[^>]*>/gi;
const ANY_TAG = /<\/?[a-z][^>]*>/gi;
/** A tag still being written when a stream is cut off mid-way: hidden until it closes. */
const OPEN_TAG = /<\/?[a-z][^>]*$/i;

export function plainText(text: string): string {
  return text
    .replace(BLOCK_TAG, '\n')
    .replace(ANY_TAG, '')
    .replace(OPEN_TAG, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    // Headings, bullets, numbered items and quotes: the marker goes, the words stay on their own line.
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*(?:[-*+•·]|\d{1,2}[.)、])[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    // Links keep their words; code keeps its text.
    .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, '$1')
    .replace(/`+([^`\n]*)`+/g, '$1')
    // Emphasis: the words stay, the stars and underscores go. A lone marker
    // still waiting for its pair at the end of a stream goes too.
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2')
    .replace(/(\*\*|__|\*)$/, '')
    // Horizontal rules, and the blank lines lists leave behind.
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '');
}

/**
 * Tags and entities out, everything else in place: for text whose `##` and
 * `-` lines are the format being read, not noise to clean — the note a hand
 * types freehand is marked, and the markers are what make it a card.
 */
export function plainMarkedText(text: string): string {
  return text
    .replace(BLOCK_TAG, '\n')
    .replace(ANY_TAG, '')
    .replace(OPEN_TAG, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/`+([^`\n]*)`+/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '');
}
