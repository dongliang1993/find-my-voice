// Splits assistant speech into TTS-sized chunks. Shorter chunks start playing
// sooner; too short and each one sounds clipped and costs a request.

const END = /[。！？!?；;…~～]+|\.(?=\s|$)/u;
const CLOSERS = /^["'”’」』）)】]+/u;
const SOFT_BREAK = /[，,、：:\s]/u;

type Options = { minChars?: number; maxChars?: number };
const length = (text: string) => [...text].length;

function rawSentences(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest) {
    const match = END.exec(rest);
    if (!match) { out.push(rest); break; }
    let end = match.index + match[0].length;
    const closer = CLOSERS.exec(rest.slice(end));
    if (closer) end += closer[0].length;
    out.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  return out;
}

function hardWrap(sentence: string, maxChars: number): string[] {
  const out: string[] = [];
  let rest = sentence;
  while (length(rest) > maxChars) {
    const chars = [...rest];
    let cut = maxChars;
    for (let i = maxChars - 1; i > maxChars / 2; i--) if (SOFT_BREAK.test(chars[i]!)) { cut = i + 1; break; }
    out.push(chars.slice(0, cut).join(''));
    rest = chars.slice(cut).join('');
  }
  if (rest) out.push(rest);
  return out;
}

export function splitSentences(text: string, { minChars = 1, maxChars = 120 }: Options = {}): string[] {
  const pieces = rawSentences(text).map(s => s.trim()).filter(Boolean).flatMap(s => hardWrap(s, maxChars));
  return pieces.reduce<string[]>((merged, piece) => {
    const last = merged.at(-1);
    if (last !== undefined && length(last) < minChars && length(last) + length(piece) <= maxChars) {
      return [...merged.slice(0, -1), last + piece];
    }
    return [...merged, piece];
  }, []);
}
