import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/storage.js';
const config = loadConfig(); const store = new Store(config.dataDir);
try {
  const data = store.export(config.ownerId);
  const name = `experiment-${new Date().toISOString().replaceAll(':', '-')}`;
  const jsonPath = resolve(config.dataDir, `${name}.json`), markdownPath = resolve(config.dataDir, `${name}.md`);
  writeFileSync(jsonPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  const sections = [`# Finding My Voice · 实验记录\n\n导出时间：${data.exported_at}\n`, '## 已确认的共同经历\n'];
  for (const m of data.memories) sections.push(`- ${m.content}\n  来源：${m.source}${m.is_inference ? '（模型推断）' : ''}\n`);
  sections.push('\n## 角色版本\n');
  for (const s of data.identity_versions) sections.push(`### v${s.version}\n\n${s.change_reason}\n\n\`\`\`json\n${JSON.stringify(s, null, 2)}\n\`\`\`\n`);
  sections.push('\n## 试听与语音记录\n');
  for (const s of data.speeches) sections.push(`- ${s.created_at} · ${s.voice_name} · ${s.generation_mode} · ${s.state}\n  送入文本：${s.text}\n${s.spoken_text ? `  供应商字幕：${s.spoken_text}\n` : ''}`);
  writeFileSync(markdownPath, sections.join('\n'), { mode: 0o600 });
  console.log(`Exported ${jsonPath}\n${markdownPath}`);
} finally { store.close(); }
