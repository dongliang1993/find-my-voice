# Find My Voice

一个跑在你自己电脑上的 AI 伴侣聊天应用。她会打字，也会发语音给你；她记得你，也有自己的性格。

```sh
npx find-my-voice
```

浏览器会自动打开聊天界面。所有数据：聊天记录、语音、她的记忆和性格，都只保存在本机的 `~/.find-my-voice/`。

## 需要准备什么

| | 用途 | 怎么配置 |
|---|---|---|
| **大脑** | 她的思考与对话 | 已经在用 Claude Code 的话自动沿用其配置（API Key、网关、Bedrock/Vertex）。否则在设置里选服务商（Anthropic / DeepSeek / Kimi / 智谱）并粘贴 API Key |
| **声音** | 她的语音 | 火山引擎「豆包语音合成大模型」、Fish Audio 或 ElevenLabs 的 API Key，在设置 → 声音里选一家填写 |

需要 Node.js 22.13 或更高版本。

> 不支持用 claude.ai 订阅登录驱动：Anthropic 不允许第三方应用使用订阅额度。

## 她是谁

- `~/.find-my-voice/IDENTITY.md`：她的性格、说话方式、你们的关系
- `~/.find-my-voice/MEMORY.md`：她对你的了解

两份都是普通 Markdown，可以直接编辑，下一条消息生效。没有写的时候，她会用默认性格，在聊天中慢慢认识你。

## 开发

```sh
npm install
npm run dev        # 后端（自动重启）+ Vite 前端，打开 http://localhost:5173
npm test           # 单元测试
npm run build      # 类型检查 + 构建到 dist/
```

开发时用一份独立的数据目录，避免污染自己的聊天记录；把 TTS 换成离线的测试提示音，不消耗额度：

```sh
mkdir -p /tmp/fmv-dev
echo '{"voice":{"provider":"fixture"}}' > /tmp/fmv-dev/config.json
FIND_MY_VOICE_HOME=/tmp/fmv-dev npm run dev
```

### 结构

```
src/shared/protocol.ts     浏览器 ↔ 服务端的消息协议（两端共用的类型）
src/server/
  brain/                   Claude Agent SDK 会话、认证探测、工具（send_voice）
  chat/                    对话编排（ChatService）与 SQLite 存储
  voice/                   各家 TTS、按句切分、流式管线
  profile/                 IDENTITY.md / MEMORY.md 与人设 prompt
  http.ts                  REST + WebSocket
web/src/                   React 聊天界面、Web Audio 流式播放
```

大脑运行在隔离模式：不加载你的 `~/.claude` 设置、CLAUDE.md、skills 或内置工具，只继承认证相关的环境变量，她只有自己的工具。
