# Find My Voice · 本地 MCP 与声音初始化

目标入口是：

```sh
npx find-my-voice install
npx find-my-voice setup
```

`install` 把服务复制到固定目录 `~/.find-my-voice/app`，安装运行时依赖并注册本机 MCP 与三个 Skill。入口不会指向 npx 缓存，升级也保留本机 `.env` 和 `data/`。默认安装到个人 Codex，可用 `--workspace /path/to/workspace` 仅注册一个工作区，或用 `--client manual` 生成其他本地 MCP 客户端的连接描述。

`setup` 不再弹出凭证、资源 ID 或测试音色问卷。重载客户端后，在**当前已有交流的 Agent 对话**中说“初始化 Finding My Voice”，Agent 会自动提取有来源的共同经历和自己的表达画像，展示草稿供你修改与确认；保存仍由你确认。CLI 只检查进度并给出交接口令，不能把终端连接到正在进行的聊天，也不拥有全部历史。

流程为：自动整理共同经历 → 确认记忆与表达画像 → 试听前连接语音服务 → Agent 选声试听 → 确认正式声音。没有语音凭证也能完成前面的记忆与画像。无需另配用于提取的模型 API Key；分析由当前宿主 Agent 完成。

```sh
npx find-my-voice setup --json  # Agent 读取进度，不询问凭证、不生成收费音频
npx find-my-voice setup --connect  # 到试听阶段，私下录入语音服务 API Key（不回显）
npx find-my-voice setup --import-config /path/to/your/private/.env  # 显式复用自己的语音配置
npx find-my-voice doctor        # 检查本机 MCP 连接
```

上面的短命令需要 `find-my-voice` 已首次发布到 npm。GitHub 源码及 Release 可独立分发；仅推送 GitHub 不会自动占用 npm 包名或完成 npm 发布。

这是安装在用户电脑上的 MCP 服务和三项 Skill：初始化、共同经历与角色演化、声音表达。首版一键安装支持 macOS + Codex；其他支持本地 MCP 的客户端可使用手动连接描述，但 Skill 加载方式需要由该客户端支持。需要 Node.js >= 22.13 和 macOS Command Line Tools。

## 给你的 Agent 的安装口令

把安装包交给本机 Agent，发送：

> 请将这个 Finding My Voice 安装包解压到我选择的固定目录，阅读 INSTALL.md，并把本地 MCP 和三个 Skill 安装到我的 Codex 用户配置。运行 sh install.command --scope user，保留已有配置。让我在本机私下配置自己的火山凭证，不要把 API Key 放进聊天。安装后验证 MCP 可以连接，先不要生成收费音频。

安装目录要长期保留：MCP 入口和 Skill 链接会指向它，不要安装在自动清理的临时目录。全局安装会修改本机 `.codex/config.toml` 并在 `.agents/skills/` 建立链接；已有配置会备份，其他来源的同名 Skill 会报告冲突并保留原状。

## 手动安装

需要 Node.js >= 22.13，以及 macOS Command Line Tools。缺少编译器时先运行 `xcode-select --install`。

解压后，在安装目录运行：

```sh
# 安装到个人 Codex，供该用户使用。
sh install.command --scope user
# 或只安装到指定工作区：
sh install.command --workspace /path/to/workspace
# 其他本地 MCP 客户端：只准备服务和连接描述，不改 Codex 配置。
sh install.command --client manual
```

安装器会安装锁定的依赖、生成私有配置、编译服务与原生 PCM 播放器，连接本地 MCP 验证六个工具与 setup 入口，然后注册 MCP 和 Skill。验证不生成付费音频。已有 `.env`、记忆、角色与音频不会被覆盖。依赖下载和本机配置修改仍由客户端执行权限控制。

试听前运行 `npx find-my-voice setup --connect`，只需私下填写你自己的火山 API Key；资源参数由候选目录提供，Agent 使用 `voice.list` 选择候选，不需要你找 speaker ID。已有本机配置时，用 `setup --import-config FILE` 显式复用；仅复制语音服务字段，不复制管理令牌、用户身份、数据目录、记忆或语音模式。

也可在安装目录的 `.env` 私下填写：

```dotenv
VOLC_API_KEY=<你的 API Key>
```

内置一个公开的 Vivi 候选（不是正式角色声音），账户权限未验证，只有你同意后的真实试听才能验证。更多候选可放入私有 `data/voices.json`；该文件存在时完全覆盖内置候选，包括禁用或空目录，不会自动启用你排除的音色。账户特殊资源或额外候选可以运行 `setup --connect --advanced` 配置，不作为常规初始化问答。

每个人使用独立密钥和本地数据；安装包不包含作者的凭证、记忆、音频或账户音色目录。配置完成后重载 MCP。读取进度和连接凭证均不生成付费音频，也不会自动开启持续语音模式。

## 从一句话开始

重载客户端后说：

> 初始化 Finding My Voice，带我整理共同经历并由你选择声音。

setup 会串起：自动提出共同经历并确认 → 自动形成表达画像并确认 → 连接语音服务 → Agent 设计声音并试听 → 确认正式声音。进度来自已保存的数据，可以随时说“继续 Finding My Voice setup”，不需要记住工具名。真实试听会产生供应商用量，开始前会说明并征求同意；读取进度和整理草稿不会调用付费音频接口。

新安装没有其他聊天的全部历史。Agent 使用当前可见交流、宿主实际提供的记忆、已确认项目记忆或明确授权的材料，保留来源并区分推断，不会扫描聊天数据库或复制作者的角色。材料不足时才询问必要信息，不让你先填写性格问卷。记忆与初步画像可一起预览；存储仍先确认记忆，再引用实际记忆 ID 确认画像。

`setup --agent codex` 仅是显式选择的新 CLI 对话入口，不继承你正在进行的聊天。需要利用当前交流时，应在原对话中初始化，而不是使用此选项。若客户端无法热加载插件，应先重载；必须新开会话时，可提供原会话摘要或明确授权的材料，不能假定历史自动转移。

默认仅在明确请求语音后生成。若希望长期让 Agent 判断何时说话，在本机 `.env` 设置下面两项并重启 MCP：

```dotenv
VOICE_REPLY_MODE=adaptive
LOCAL_AUDIO_PLAYBACK=stream
```

固定音色 TTS 可以边接收边从本机播放，成功后保存 WAV。可以说“只用文字”或“停止播放”。本机系统播放不等于网页或手机端自动播放。

## 检查与数据位置

客户端应能发现 `setup.start`、`memory.save`、`identity.update`、`voice.list`、`voice.speak`，本地还包括 `voice.control`。先调用 `setup.start` 检查连接与进度；单纯读取状态不生成音频。也可在安装目录运行 `npm run check:local`，重复做不计费的连接检查。

`.env` 保存私有凭证，`data/` 保存本机记忆、角色、试听和音频。分享安装目录前排除这些文件。卸载时从客户端移除该 MCP 和本包对应的 Skill 链接；先保留 `data/`，需要迁移时再由你决定如何处理。
