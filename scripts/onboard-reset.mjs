// Resets onboarding state so the next page load starts the first meeting
// again. For iterating on the onboarding flow.
//
//   FIND_MY_VOICE_HOME=/tmp/fmv-test-onboard node scripts/onboard-reset.mjs
//   node scripts/onboard-reset.mjs --wipe   # also drop the chat history and
//                                           # profile docs for a truly fresh dir
//
// What it touches and what it deliberately does not:
//   onboarding_state — rewritten to step 0, no draft, not completed. Not
//   deleted: ChatStore re-marks any install with chat history as done, so a
//   deleted row would just come back completed on the next start.
//   Never touches: settings (config.json), voice keys, audio archive.
//   --wipe additionally drops: messages, followups, the memory cursor,
//   IDENTITY.md / MEMORY.md (kept as *.bak), for a truly fresh first meeting.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const dir = process.env.FIND_MY_VOICE_HOME ?? resolve(homedir(), '.find-my-voice');
const wipe = process.argv.includes('--wipe');
const dbPath = resolve(dir, 'chat.sqlite');

if (!existsSync(dbPath)) {
  console.error(`没有找到 ${dbPath}——先跑一次应用让它建库，或检查 FIND_MY_VOICE_HOME。`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
try {
  // An upsert, not a delete: see the header. completed_at = NULL is what makes
  // it a first meeting again.
  db.prepare(`INSERT INTO onboarding_state (id, step, draft_json, completed_at) VALUES (1, 0, '{}', NULL)
    ON CONFLICT(id) DO UPDATE SET step = 0, draft_json = '{}', completed_at = NULL`).run();
  console.log(`onboarding 已重置 → ${dir}`);

  if (wipe) {
    // A fresh first meeting needs a fresh history: the old scripted lines
    // would otherwise pile up in the chat on every re-run.
    db.exec('DELETE FROM messages; DELETE FROM followups; DELETE FROM state;');
    for (const doc of ['IDENTITY.md', 'MEMORY.md']) {
      const path = resolve(dir, doc);
      if (existsSync(path)) {
        renameSync(path, resolve(dir, `${doc}.bak-${Date.now()}`));
      }
    }
    console.log('--wipe：聊天记录和档案已清（档案保留为 .bak），下次启动全新引导。');
  } else {
    const leftover = (db.prepare('SELECT COUNT(*) AS n FROM messages').get()).n;
    if (leftover > 0) console.log(`提醒：聊天历史里还有 ${leftover} 条旧消息（默认保留；要全新就用 --wipe）。`);
  }
} finally {
  db.close();
}
