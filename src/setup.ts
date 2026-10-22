import { existsSync } from 'node:fs';
import type { Config } from './config.js';
import type { Store } from './storage.js';
import { listVoices } from './catalog.js';
import { readProfile } from './profile.js';
import { voiceApiContract } from './speech-contract.js';

type StepState = 'complete' | 'current' | 'awaiting_confirmation' | 'blocked' | 'upcoming';
export function setupStatus(config: Config, store: Store, baseUrl: string, local: boolean) {
  const identity = store.snapshot(config.ownerId);
  const memories = store.memories(config.ownerId);
  const documents = readProfile(config);
  const pending = store.pendingList(config.ownerId).filter(p => p.role_id === 'default' && p.state === 'pending');
  const credentials = Boolean(config.volc.apiKey || (config.volc.appId && config.volc.accessKey));
  let voices: ReturnType<typeof listVoices> = [];
  try { voices = listVoices(config).filter(v => v.enabled); } catch { /* Report a blocked connection instead of hiding all setup progress. */ }
  const providerConfigured = config.provider === 'volcengine' && credentials && voices.some(v => v.resource_id || config.volc.resourceId);
  const samples = store.db.prepare(`SELECT id,voice_id,voice_name,identity_version,profile_hash,file_path,expires_at FROM speeches
    WHERE owner_id=? AND role_id='default' AND state='completed' AND provider='volcengine'
    AND generation_mode='tts' ORDER BY created_at DESC`)
    .all(config.ownerId).filter(s => documents.fingerprint && s.profile_hash === documents.fingerprint && s.file_path && existsSync(String(s.file_path)) && Date.parse(String(s.expires_at)) > Date.now());
  const relevantSamples = identity.voice ? samples.filter(s => s.voice_id === identity.voice!.voice_id) : samples;
  const memoryReady = documents.memory.ready && documents.layout.memory.ready;
  const groundedIdentity = memoryReady && documents.identity.ready && documents.layout.identity.ready;
  const confirmedVoice = Boolean(identity.voice && voices.some(v => v.id === identity.voice!.voice_id));
  const definitions = [
    { id: 'memory', label: '生成或同步日期化记忆 MEMORY.md', complete: memoryReady,
      detail: memoryReady ? `记忆资料：${documents.memory.path}` : `由 AI 回顾获授权历史和宿主原生记忆；缺少资料块：${documents.layout.memory.missing_blocks.join('、')}。`,
      next: `使用 identity-evolution 的 v2 格式，由 AI 提取个人重要事实、生活事件、偏好与持续关切，不罗列工程日志。生成/合并 ${documents.memory.path} 的回顾范围、当前有效记忆、按日期关联 session 的记忆时间线、冲突与待核实、同步记录。处理主体/场景/有效时间，保留被替代历史，原生记忆纠正同步进文件。可用 setup --agent codex --history FILE 无界面提取，或在有历史能力的宿主提交同一请求；不假装已读全部云端历史。使用 profile.write 或正常文件权限保存。` },
    { id: 'identity', label: '检查形象、性格与匹配的声音', complete: groundedIdentity,
      detail: groundedIdentity ? `分块画像：${documents.identity.path}` : `先检查已有形象，有则沿用，没有则由 AI 设计。缺少资料块：${documents.layout.identity.missing_blocks.join('、')}。`,
      next: `读取 MEMORY.md 和已有画像、获授权的宿主形象资料，生成/合并 ${documents.identity.path} 四个块：个人形象、性格与关系、声音、演化记录。没有既有形象时基于历史设计具体初始形象，明确是设计不是历史事实；回答“用户眼中的我”，不是写通用工作守则。声音表达与形象和性格匹配，保留运行时已确认声音，无则标记待试听确认。使用 profile.write 或正常文件权限保存，无需 SQLite 人格审核或 TTS 凭证。` },
    { id: 'connection', label: '连接语音服务', complete: providerConfigured,
      detail: providerConfigured ? '凭证和候选音色已配置；账户权限尚需真实合成验证。' : '记忆和画像无需语音凭证。试听前在本机运行 setup --connect 私下连接语音服务，不在对话中发送密钥。',
      next: credentials ? '检查本地候选音色目录。优先使用目录自带的资源参数；仅在账户权限或目录异常时使用 setup --connect --advanced，不让用户手填测试音色作为正式选声。' :
        '现在需要连接语音服务才能试听。在本机运行 npx find-my-voice setup --connect；已有私有配置可用 --import-config FILE 显式复用，随后重载 MCP。不要让用户把密钥贴到聊天。' },
    { id: 'audition', label: '设计声音并试听', complete: groundedIdentity && relevantSamples.length > 0,
      detail: relevantSamples.length && groundedIdentity ? `已有 ${relevantSamples.length} 条角色建立后的真实 TTS 样本。` : 'Agent 给出声音设计与首选理由，再用相同台词生成少量候选试听。',
      next: '由 Agent 读取个人形象、性格与关系、声音块及有效记忆，先提出与形象匹配的声音判断，调用 voice.list 比较候选；经用户同意收费试听后调用 voice.speak。不要默认让用户自己从音色列表选。网页调用 playback: none。' },
    { id: 'voice', label: '确认并开始交流', complete: groundedIdentity && confirmedVoice && relevantSamples.length > 0,
      detail: confirmedVoice && groundedIdentity && relevantSamples.length ? '正式声音已确认，后续回复可以复用。' : 'Agent 吸收听感反馈并给出最终选择，你确认后保存声音配置。',
      next: '解释最终选声理由和反馈如何影响判断，再用 identity.update 提交具体 voice 配置；用户确认后重新读取 setup.start 检查是否就绪。' },
  ];
  let reachedCurrent = false;
  const steps = definitions.map(step => {
    const review = pending.find(p => step.id === 'voice' && p.kind === 'identity' && Boolean('voice' in p.payload && p.payload.voice));
    const state: StepState = step.complete ? 'complete' : review ? 'awaiting_confirmation' : reachedCurrent ? 'upcoming' : step.id === 'connection' ? 'blocked' : 'current';
    if (!step.complete) reachedCurrent = true;
    return { id: step.id, label: step.label, state, detail: step.detail,
      ...(review ? { review_url: `${baseUrl}/review/${review.id}`, pending_id: review.id } : {}) };
  });
  // Credentials are required only after the non-paid memory and identity workflow.
  const next = definitions.find(step => !step.complete);
  const ready = definitions.every(step => step.complete);
  return {
    voice_api: voiceApiContract(local),
    ready, next_step: ready ? 'ready' : next!.id,
    next_action: ready ? '复用已确认的角色和声音开始交流；尊重用户选择的语音或文字模式。' : next!.next,
    steps, memory_count: memories.length, identity_version: identity.version,
    voice_id: identity.voice?.voice_id ?? null, provider_configured: providerConfigured,
    profile_documents: documents,
    connection: { credentials_configured: credentials, candidate_count: voices.length, account_permissions_verified: false },
    agent_handoff: {
      target: 'current_conversation', extraction_owner: 'host_agent', automatic_draft: true,
      context_resource: 'finding-my-voice://context/default',
      allowed_sources: ['host_authorized_history_search', 'visible_conversation', 'host_provided_memory', 'local_profile_documents', 'explicitly_authorized_material'],
      all_history_access: 'host_dependent', history_extraction_owner: 'host_agent',
      persistence: 'two_local_markdown_documents', write_tool: 'profile.write',
      document_review: 'normal_host_file_permissions', voice_confirmation_required: true,
      separate_model_credentials_required: false,
      headless: { agent: 'codex', command: 'setup --agent codex --history FILE', fallback: 'setup --agent request --history FILE',
        inherits_cloud_history: false, history_files_require_explicit_selection: true },
      profile_format_version: 2,
    },
    sample_ids: relevantSamples.map(s => String(s.id)),
    management_url: `${baseUrl}/admin`,
    playback: local ? { target: 'local_mac', mode: config.localAudioPlayback, automatic_playback_verified: false } :
      { target: 'browser', mode: 'audio_component', requires_user_activation: true, automatic_playback_verified: false },
    web_connection: { remote_client_tested: false, single_owner_service: true },
    resume_prompt: '初始化或继续 Finding My Voice。读取 setup.start、context/default 及 identity-evolution 的 references/profile-format.md。由实际 AI 使用已获授权历史和原生记忆提取，不由安装脚本编造人格；支持 setup --agent codex --history FILE 无界面调用，或在能访问历史的原宿主提交同一请求。MEMORY.md 按日期组织、关联 session，包含当前有效记忆、时间线、冲突与待核实、同步记录；偏好变化保留新旧版本，不能把别人的经历或工程日志当个人记忆。IDENTITY.md 分为个人形象、性格与关系、声音、演化记录；先沿用已有形象，无则根据历史设计并标明初始设计，声音须与形象气质匹配；区分用户眼中的我、实际互动与暂时推断。已有资料先读后合并，保存核验并给出文件链接及覆盖缺口，不假装已读全部云端聊天。不走旧记忆/人格审核链路，没有 TTS 凭证也先完成文档；后续才连接、选声、经授权试听并由用户确认正式声音。',
  };
}
