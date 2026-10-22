# 本地开发

生产安装在 `~/.find-my-voice/app`，本目录是**独立的开发副本**，两边互不影响。

## 快速开始

```sh
npm ci
npm run dev         # tsx 直跑源码，改完自动重载，不用 build
```

`npm run dev` 起的是 `http://127.0.0.1:3210/admin`。改 `src/` 和 `public/` 都会自动生效——`admin.html` 是每次请求现读的，不走 `dist/`。

## 验证方式

| 模式 | 命令 | 需要凭证 | 计费 |
|---|---|---|---|
| 单测 | `npm test` | 否 | 否 |
| 类型检查 | `npx tsc --noEmit` | 否 | 否 |
| 本地 MCP 冒烟 | `npm run check:local` | 否 | 否 |
| 真实 TTS | `.env` 改 `TTS_PROVIDER=volcengine` + 填 `VOLC_API_KEY` | 是 | **是** |

## 在 Codex 里调试

已注册 `find_my_voice_dev`（`~/.codex/config.toml`），和生产条目 `finding_my_voice` 并存。

**这条路径走 `dist/`，改完必须 `npm run build` 再重载 Codex**，否则跑的是旧代码。

两条路二选一：
- 改前端 / 页面交互 → `npm run dev`，改完刷新浏览器
- 验 MCP 工具行为 → `npm run build` + 重载 Codex

## 管理页由 MCP 进程托管

不需要单独起服务。MCP 进程连上时已经在 `127.0.0.1:3210` 提供管理页，**只要 Codex 连着就能打开**：

```
http://127.0.0.1:3210/admin
```

地址也会出现在 `setup.start` 的 `management_url` 里。

端口被占用（比如你同时开着 `npm run dev`）时不会失败，会自动换随机端口并在 stderr 提示，`management_url` 跟着变。

卸载 dev 条目：

```sh
node scripts/setup-codex.mjs --server-name find_my_voice_dev --scope user --claim-skills
```

## 注意事项

- **`dist/` 是构建产物**，被 gitignore。`npm run dev`（tsx）会以 `src/` 为根，找不到 `skills/` 和 `public/`；要完整链路请用 `npm run build && npm run stdio`。
- **`scripts/speak.ts` 不跑 build**，直接吃 `dist/`。和 `dev` 混用会跑到旧代码。
- 技能软链接目前指向本目录。生产环境要重新接管时，在 `~/.find-my-voice/app` 跑 `node scripts/setup-codex.mjs --scope user --claim-skills`。
- `.env` 权限必须是 600，且已被 gitignore。

## 对上游的改动

本目录相对上游多了三个开关，用于 dev/prod 共存：

- `scripts/setup-codex.mjs --server-name <name>` — 注册到不同 server 名
- `scripts/setup-codex.mjs --claim-skills` — 允许接管已有的技能软链接
- `package.json` 的 `dev:watch` / `dev:stdio` 脚本
