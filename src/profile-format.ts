export const profileSections = {
  memory: ['回顾范围', '当前有效记忆', '记忆时间线', '冲突与待核实', '同步记录'],
  identity: ['个人形象', '性格与关系', '声音', '演化记录'],
} as const;

// Structural check only. Historical truth, conflict resolution and image/voice
// compatibility remain the extracting AI's job, not heading-based heuristics.
export function inspectProfileFormat(name: keyof typeof profileSections, content: string | null) {
  const blocks = new Map<string, string>();
  let current: string | undefined; let fence: string | undefined;
  for (const line of (content ?? '').replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const delimiter = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (delimiter) {
      if (!fence) fence = delimiter[1]![0];
      else if (fence === delimiter[1]![0]) fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (heading) { current = heading[1]; if (!blocks.has(current!)) blocks.set(current!, ''); }
    else if (/^#\s/.test(line)) current = undefined;
    else if (current && line.trim() && !/^#{1,6}\s/.test(line)) blocks.set(current, `${blocks.get(current)}\n${line}`);
  }
  const missing = profileSections[name].filter(section => !blocks.get(section)?.trim());
  return { version: 2, ready: missing.length === 0, missing_blocks: missing, required_blocks: [...profileSections[name]] };
}
