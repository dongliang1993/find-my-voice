// Best-effort parsing of JSON that is still being written. A letter arrives as
// the input of a tool call, streamed a few characters at a time; to start
// writing before it is finished, each prefix is closed off into the largest
// valid document it can be: an open string is ended, open arrays and objects
// are shut, and a dangling key or half a literal is cut back to the last
// complete value.
//
// Its own small parser because the only ready-made one lives in a package this
// project does not depend on directly.

/** Closes an unfinished prefix: ends an open string, then shuts every open bracket. */
function close(prefix: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of prefix) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') stack.push('}');
    else if (char === '[') stack.push(']');
    else if (char === '}' || char === ']') stack.pop();
  }
  // A string cut right after a backslash cannot be closed; the backslash goes.
  const body = inString && escaped ? prefix.slice(0, -1) : prefix;
  return body + (inString ? '"' : '') + stack.reverse().join('');
}

/** Positions to cut back to, latest first: before each comma, and just after each opening bracket. */
function cutPoints(text: string): number[] {
  const points: number[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === ',') points.push(i);
    else if (char === '{' || char === '[') points.push(i + 1);
  }
  return points.reverse();
}

const tryParse = (text: string): { ok: true; value: unknown } | { ok: false } => {
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; }
};

/**
 * The value a JSON prefix is heading towards, as far as it can be read. Strings
 * cut mid-way come back cut; a key with no value yet is left out. Undefined
 * when not even the outermost bracket has arrived.
 */
export function parsePartialJson(text: string): unknown {
  const whole = tryParse(text);
  if (whole.ok) return whole.value;
  const closed = tryParse(close(text));
  if (closed.ok) return closed.value;
  // Each cut drops one dangling piece (a key without a value, half a literal);
  // the first one that parses keeps the most of what was written.
  for (const point of cutPoints(text)) {
    const attempt = tryParse(close(text.slice(0, point)));
    if (attempt.ok) return attempt.value;
  }
  return undefined;
}
