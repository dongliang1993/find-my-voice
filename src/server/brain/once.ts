/** Which of the two ways a voice message reaches the brain saw it. */
export type VoiceSource = 'stream' | 'tool';

/**
 * Each send_voice call reaches the brain twice: once in the stream, the moment
 * its arguments are complete, and once as the tool call itself. Either can
 * come first — the SDK answers tool calls at once, while stream events wait in
 * line for the reader — so whichever arrives first sends it, and the other,
 * finding it waiting, only clears it.
 */
export class VoiceOnce {
  private waiting: Record<VoiceSource, string[]> = { stream: [], tool: [] };

  /** True when this sighting is the one that should send the voice. */
  claim(source: VoiceSource, text: string): boolean {
    const other = source === 'stream' ? 'tool' : 'stream';
    const at = this.waiting[other].indexOf(text);
    if (at >= 0) {
      this.waiting = { ...this.waiting, [other]: this.waiting[other].filter((_, i) => i !== at) };
      return false;
    }
    this.waiting = { ...this.waiting, [source]: [...this.waiting[source], text] };
    return true;
  }

  reset() { this.waiting = { stream: [], tool: [] }; }
}
