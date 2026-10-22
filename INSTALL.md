# Find My Voice · 本地 MCP 与声音初始化

目标入口是：

```sh
npx find-my-voice install
npx find-my-voice setup
```

`install` 把服务复制到固定目录 `~/.find-my-voice/app`，安装运行时依赖并注册本机 MCP 与三个 Skill。入口不会指向 npx 缓存，升级也保留本机 `.env` 和 `data/`。默认安装到个人 Codex，可用 `--workspace /path/to/workspace` 仅注册一个工作区，或用 `--client manual` 生成其他本地 MCP 客户端的连接描述。

`setup` 是两份文档生成、形象检查和后续选声的统一入口，不弹出凭证、资源 ID 或测试音色问卷。可在原 Agent 对话中说“初始化 Finding My Voice”，由具有历史权限的宿主提取；也可用 `setup --agent codex --history FILE` 调用官方 `codex exec` 无界面生成并保存。模型负责理解和写作，脚本只提供请求、检查结构和并发、保留备份。没有 CLI 时用 `--agent request` 生成同一请求交给原宿主。文档写入不增加逐条 MCP 审核。

流程为：读取旧资料和已授权历史/原生记忆 → 生成或同步日期化 MEMORY.md → 检查已有形象，无则由模型设计 → 形成性格与匹配的声音块，保存 IDENTITY.md → 连接语音 → Agent 选声试听 → 确认正式声音。无界面入口使用既有 Codex 登录、隔离项目/自定义 provider 配置，不另索取模型 API Key；没有语音凭证也能完成文档。无界面进程不会自动继承全部 ChatGPT 云端历史。

## 两份本地基础资料

默认安装下的主文件为：

```text
~/.find-my-voice/app/data/MEMORY.md
~/.find-my-voice/app/data/IDENTITY.md
```

自定义数据目录时，以 `setup.start` 或 `setup --json` 的 `profile_documents` 路径为准。

- `MEMORY.md`：回顾范围、当前有效记忆、按日期且关联 session 的记忆时间线、冲突与待核实、同步记录。偏好改变时当前值更新、旧版本标记被替代并保留；不是简单“最后一句覆盖”，也不是工程日志。
- `IDENTITY.md`：个人形象、性格与关系、声音、演化记录。先沿用已有形象，没有才根据历史设计具体初始形象并标明设计性质；以第一人称理解“用户眼中的我”。声音表达与形象气质协调，候选设计不等于已确认音色，实际绑定以运行时已确认 voice 为准。

完整格式与冲突/同步规则在 `skills/identity-evolution/references/profile-format.md`，Skill 与无界面请求共用。`setup --json` 的 `profile_documents.layout` 报告缺块，旧格式保留并进入迁移，不删除重置；结构合格不代表程序已验证所有历史事实。文本形象设计不冒充已生成头像图片。

两份 Markdown 是记忆与画像的主要资料，可用本地全文搜索，也通过 `finding-my-voice://profile/memory`、`finding-my-voice://profile/identity` 读取。后续宿主按主题读取相关段落，再组织回复和 TTS 台词；更新时先读旧文档、查证历史并合并，不每轮重塑性格。资料不会更改底层模型，也不会自动进入所有无关会话的系统上下文。

宿主可用正常文件编辑能力生成文档，或调用 `profile.write`（新建 `base_sha256: null`，更新使用刚读取的哈希）。工具只写两份指定文件，不负责历史读取；更新保留私有 `profile-history/*.bak`，哈希冲突要求重新读取合并。文档单份最大 256 KiB。初始化不生成占位模板，不把两次安装排障当成完整关系历史。能否读取全部历史取决于宿主工具和权限，文档必须说明已读与缺失范围。

SQLite 保留声音配置、音频、旧版记忆和审核记录；旧内容可作有来源的迁移参考，不再作为新 Markdown 初始化的前置条件。旧拒绝草稿不会自动写入文档或阻塞初始化。正式声音确认仍独立进行。

```sh
npx find-my-voice setup --json  # Agent 读取进度，不询问凭证、不生成收费音频
npx find-my-voice setup --agent codex --history /path/to/history.json --history /path/to/native-memory.md
npx find-my-voice setup --agent request --history /path/to/history.json  # 无 CLI 时生成同一请求
npx find-my-voice setup --agent codex --refresh-profile  # 显式合并更新已有文档
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

安装器会安装锁定的依赖、生成私有配置、编译服务与原生 PCM 播放器，验证本地七个工具与 setup 入口，然后注册 MCP 和 Skill。验证不生成付费音频或个人资料。已有 `.env`、Markdown、旧记录与音频不会被覆盖。依赖下载和本机配置修改仍由客户端执行权限控制。

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

setup 根据实际文件继续：生成 MEMORY.md → 生成 IDENTITY.md → 连接语音 → 设计并试听 → 确认声音。中断后可随时继续，不能把待生成的文档说成已完成。真实试听会产生供应商用量，开始前会说明并征求同意；读取状态和生成资料不调用付费音频接口。

新安装不携带作者的历史或人格。宿主应使用自身已授权的历史搜索、会话读取和原生记忆，尽量覆盖全部可访问历史，分批整理并记录范围。没有读取能力时如实说明缺口，允许导入材料，不假装 MCP 天生能看到所有聊天，也不绕过权限扫描私有数据库。文档保留来源、区分事实与推断，并排除密钥等敏感信息。

正式声音和旧版逐条存储的审核表单明确提供“确认保存 / 暂不决定 / 拒绝这份草稿”。关闭、取消、拒绝填写或表单不可用时保留待确认。没有表单时，Agent 给出审核链接和完整 `review_command`，由你本人执行。文档生成不走这层审核。旧拒绝记录不自动撤销；新审核请求需用新 ID，查询旧 ID 只返回旧决定。

`setup --agent codex` 现在是无界面提取而非交互聊天入口，不需要 TTY。新建资料必须用 `--history FILE` 明确选择来源，可重复传入历史导出、原生记忆及已有形象描述（Markdown、文本、JSON/JSONL；不接受目录或凭证文件）。没有新增来源时，可基于现有 MEMORY 显式刷新；完整分块已就绪则默认不重写。请求和原始结果保存在私有 `data/setup-runs/`，失败或输出缺块不覆盖两份正式文档；提取期间文件变化则拒绝覆盖，保存仍使用哈希检查和备份。宿主原生 memory 只有通过明确提供的材料或宿主已授权能力才能同步，当前不实现后台自动双向同步。

默认仅在明确请求语音后生成。若希望长期让 Agent 判断何时说话，在本机 `.env` 设置下面两项并重启 MCP：

```dotenv
VOICE_REPLY_MODE=adaptive
LOCAL_AUDIO_PLAYBACK=stream
```

固定音色 TTS 可以边接收边从本机播放，成功后保存 WAV。可以说“只用文字”或“停止播放”。本机系统播放不等于网页或手机端自动播放。

日常语音调用统一为 `Agent → MCP voice.speak → 常驻 VoiceService → TTS 适配器 → 播放与归档`。Agent 通常只提交 `request_id` 与 `text`，无需编写转换/播放代码、读取凭证或处理供应商协议。工具断连时保留文字并提示重连，不自动改用脚本。CLI 必须显式带 `--diagnostic`，只用于用户要求的开发排障，不作为对话默认后备。服务返回 `service_execution` 与 `delivery`；服务管理本地播放时，不再手动播放归档文件。此约定同时写入 Skill、MCP 发现说明与 `voice_api` 上下文；更改后需要重连 MCP 才能刷新进程及工具说明。

## 检查与数据位置

客户端应能发现 `setup.start`、`profile.write`、`voice.list`、`voice.speak`、确认声音用的 `identity.update`，以及兼容旧流程的 `memory.save`；本地另有 `voice.control`。先调用 `setup.start` 获取文件路径与进度；也可在安装目录运行 `npm run check:local` 检查连接，不生成音频。

`.env` 保存私有凭证，`data/` 保存两份主文档、私有备份、声音配置和音频。分享代码或安装包前排除整个私有目录。卸载时先保留 `data/`；迁移可复制两份文档，声音和记录另行迁移。导出记录也包含当前两份 Markdown 正文。
