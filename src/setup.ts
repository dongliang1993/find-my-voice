import { existsSync } from 'node:fs';
import type { Config } from './config.js';
import type { Store } from './storage.js';
import { listVoices } from './catalog.js';

type StepState = 'complete' | 'current' | 'awaiting_confirmation' | 'blocked' | 'upcoming';
export function setupStatus(config: Config, store: Store, baseUrl: string, local: boolean) {
  const identity = store.snapshot(config.ownerId);
  const memories = store.memories(config.ownerId);
  const pending = store.pendingList(config.ownerId).filter(p => p.role_id === 'default' && p.state === 'pending');
  const credentials = Boolean(config.volc.apiKey || (config.volc.appId && config.volc.accessKey));
  let voices: ReturnType<typeof listVoices> = [];
  try { voices = listVoices(config).filter(v => v.enabled); } catch { /* Report a blocked connection instead of hiding all setup progress. */ }
  const providerConfigured = config.provider === 'volcengine' && credentials && voices.some(v => v.resource_id || config.volc.resourceId);
  const samples = store.db.prepare(`SELECT id,voice_id,voice_name,identity_version,file_path,expires_at FROM speeches
    WHERE owner_id=? AND role_id='default' AND state='completed' AND provider='volcengine'
    AND generation_mode='tts' AND identity_version>0 ORDER BY created_at DESC`)
    .all(config.ownerId).filter(s => s.file_path && existsSync(String(s.file_path)) && Date.parse(String(s.expires_at)) > Date.now());
  const relevantSamples = identity.voice ? samples.filter(s => s.voice_id === identity.voice!.voice_id) : samples;
  const activeIds = new Set(memories.map(m => m.id));
  const groundedIdentity = Boolean(identity.identity && identity.memory_ids?.length && identity.memory_ids.every(id => activeIds.has(id)));
  const confirmedVoice = Boolean(identity.voice && voices.some(v => v.id === identity.voice!.voice_id));
  const definitions = [
    { id: 'memory', label: '整理共同经历', complete: memories.length > 0,
      detail: memories.length ? `已有 ${memories.length} 条有效记忆。` : 'Agent 根据当前可用交流提出记忆草稿，由你确认保存。',
      next: '留在当前对话，读取已保存上下文；直接从实际可见交流、宿主提供的记忆或已授权材料提取共同经历草稿，标注来源和推断，排除凭证等敏感内容。不要先要求用户填写经历或性格问卷；材料不足时只询问缺少的内容。调用 memory.save 并等待用户确认，不替用户批准。' },
    { id: 'identity', label: '形成表达画像', complete: groundedIdentity,
      detail: groundedIdentity ? `当前表达画像为 v${identity.version}。` : 'Agent 根据已确认记忆提出表达原则、处理分歧的方式和不确定项。',
      next: '读取有效记忆 ID 和角色版本，由 Agent 自动提出自己的表达原则、分歧处理方式及不确定项，不分析用户人格，不要求用户预设性格。调用 identity.update 提交有依据的画像并等待用户确认。' },
    { id: 'connection', label: '连接语音服务', complete: providerConfigured,
      detail: providerConfigured ? '凭证和候选音色已配置；账户权限尚需真实合成验证。' : '记忆和画像无需语音凭证。试听前在本机运行 setup --connect 私下连接语音服务，不在对话中发送密钥。',
      next: credentials ? '检查本地候选音色目录。优先使用目录自带的资源参数；仅在账户权限或目录异常时使用 setup --connect --advanced，不让用户手填测试音色作为正式选声。' :
        '现在需要连接语音服务才能试听。在本机运行 npx find-my-voice setup --connect；已有私有配置可用 --import-config FILE 显式复用，随后重载 MCP。不要让用户把密钥贴到聊天。' },
    { id: 'audition', label: '设计声音并试听', complete: groundedIdentity && relevantSamples.length > 0,
      detail: relevantSamples.length && groundedIdentity ? `已有 ${relevantSamples.length} 条角色建立后的真实 TTS 样本。` : 'Agent 给出声音设计与首选理由，再用相同台词生成少量候选试听。',
      next: '由 Agent 根据记忆和画像先提出声音判断，调用 voice.list，再调用 voice.speak 试听；不要默认让用户自己从音色列表选。网页调用 playback: none。' },
    { id: 'voice', label: '确认并开始交流', complete: groundedIdentity && confirmedVoice && relevantSamples.length > 0,
      detail: confirmedVoice && groundedIdentity && relevantSamples.length ? '正式声音已确认，后续回复可以复用。' : 'Agent 吸收听感反馈并给出最终选择，你确认后保存声音配置。',
      next: '解释最终选声理由和反馈如何影响判断，再用 identity.update 提交具体 voice 配置；用户确认后重新读取 setup.start 检查是否就绪。' },
  ];
  let reachedCurrent = false;
  const steps = definitions.map(step => {
    const review = pending.find(p => step.id === 'memory' ? p.kind === 'memory' :
      step.id === 'identity' ? p.kind === 'identity' && Boolean('identity' in p.payload && p.payload.identity) :
      step.id === 'voice' ? p.kind === 'identity' && Boolean('voice' in p.payload && p.payload.voice) : false);
    const state: StepState = step.complete ? 'complete' : review ? 'awaiting_confirmation' : reachedCurrent ? 'upcoming' : step.id === 'connection' ? 'blocked' : 'current';
    if (!step.complete) reachedCurrent = true;
    return { id: step.id, label: step.label, state, detail: step.detail,
      ...(review ? { review_url: `${baseUrl}/review/${review.id}`, pending_id: review.id } : {}) };
  });
  // Credentials are required only after the non-paid memory and identity workflow.
  const next = definitions.find(step => !step.complete);
  const ready = definitions.every(step => step.complete);
  return {
    ready, next_step: ready ? 'ready' : next!.id,
    next_action: ready ? '复用已确认的角色和声音开始交流；尊重用户选择的语音或文字模式。' : next!.next,
    steps, memory_count: memories.length, identity_version: identity.version,
    voice_id: identity.voice?.voice_id ?? null, provider_configured: providerConfigured,
    connection: { credentials_configured: credentials, candidate_count: voices.length, account_permissions_verified: false },
    agent_handoff: {
      target: 'current_conversation', extraction_owner: 'host_agent', automatic_draft: true,
      context_resource: 'finding-my-voice://context/default',
      allowed_sources: ['visible_conversation', 'host_provided_memory', 'confirmed_project_memory', 'explicitly_authorized_material'],
      all_history_access: false, user_confirmation_required: true,
      separate_model_credentials_required: false,
    },
    sample_ids: relevantSamples.map(s => String(s.id)),
    management_url: `${baseUrl}/admin`,
    playback: local ? { target: 'local_mac', mode: config.localAudioPlayback, automatic_playback_verified: false } :
      { target: 'browser', mode: 'audio_component', requires_user_activation: true, automatic_playback_verified: false },
    web_connection: { public_https_configured: Boolean(config.publicBaseUrl),
      remote_client_tested: false, single_owner_service: true },
    resume_prompt: '在当前对话初始化或继续 Finding My Voice。先调用 setup.start 并读取 finding-my-voice://context/default；直接根据你实际可见的交流、宿主提供的记忆和已授权材料，自动提取有来源的共同经历及你自己的表达画像草稿，区分事实和推断，不让我填写性格问卷，不假定能读取全部历史。展示草稿供我确认后再保存，使用有效记忆 ID 建立画像。没有语音凭证也先完成记忆和画像，试听前再连接服务。由你设计并选择声音，我提供听感反馈；不要代我批准任何保存，也不要未经同意生成收费试听。',
  };
}
