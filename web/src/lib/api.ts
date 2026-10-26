import type { AppStatus, Comfort, HeardAlias, Paper, PublicSettings, Rhythm, SettingsUpdate } from '@shared/protocol';

export type { AppStatus };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const body = await response.json().catch(() => null) as { message?: string } | null;
  if (!response.ok) throw new Error(body?.message ?? `请求失败（${response.status}）`);
  return body as T;
}

export const api = {
  status: () => request<AppStatus>('/api/status'),
  settings: () => request<PublicSettings>('/api/settings'),
  saveSettings: (patch: SettingsUpdate) => request<PublicSettings>('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  onboarding: () => request<OnboardingState>('/api/onboarding'),
  saveOnboarding: (step: number, draft: Record<string, unknown>, completed: boolean) =>
    request<OnboardingState>('/api/onboarding', { method: 'PUT', body: JSON.stringify({ step, draft, completed }) }),
  /** A scripted line; `audioId` is set when it is spoken, for waiting on. */
  say: (text: string, speak: boolean) =>
    request<{ messageId: string; audioId: string | null; spoken: boolean }>('/api/onboarding/say', {
      method: 'POST', body: JSON.stringify({ text, speak }),
    }),
  /** A spoken message in chat: transcript only, sent on over the socket afterwards. */
  hear: (audio: Blob, mime: string) =>
    request<{ text: string }>('/api/hear', { method: 'POST', body: audio, headers: { 'Content-Type': mime } }),
  /** The spoken answer to "what should I call you": what she heard, and the alias in it. */
  hearAlias: (audio: Blob, mime: string) =>
    request<HeardAlias>('/api/onboarding/hear-alias', { method: 'POST', body: audio, headers: { 'Content-Type': mime } }),
  /** One name proposal from the model, with the server-side retry limit. */
  proposeName: (alias: string, notes: string) =>
    request<ProposalResponse>('/api/onboarding/propose-name', { method: 'POST', body: JSON.stringify({ alias, notes }) }),
  /** The last call: names, the answers, and onboarding closed for good. */
  finishOnboarding: (final: {
    alias: string; companionName: string; nameOrigin: string; notes: string;
    comfort: Comfort; rhythm: Rhythm;
  }) => request<unknown>('/api/onboarding/finish', { method: 'POST', body: JSON.stringify(final) }),
  /** Whether an archived line is ready to play; used to poll synthesis. */
  audioReady: (id: string) => fetch(`/api/audio/${id}`, { method: 'HEAD' }).then(response => response.ok),
  /** The archive of a spoken line. */
  audioUrl: (id: string) => `/api/audio/${id}`,
  /** Has her say a line she only typed; its voice arrives on the socket. */
  voiceMessage: (id: string) => request<{ audioId: string }>(`/api/messages/${id}/voice`, { method: 'POST' }),
  /** Onto the Papers list; it stays where it is. */
  savePaper: (id: string) => request<Paper>(`/api/papers/${id}/save`, { method: 'POST' }),
  /** Back on the stage, from its card in the history. */
  stagePaper: (id: string) => request<Paper>(`/api/papers/${id}/stage`, { method: 'POST' }),
  /** Off the stage; nothing else changes. */
  closeStage: () => fetch('/api/stage', { method: 'DELETE' }).then(r => { if (!r.ok) throw new Error('收不走'); }),
  deletePaper: (id: string) => fetch(`/api/papers/${id}`, { method: 'DELETE' }).then(r => { if (!r.ok) throw new Error('删不掉'); }),
  /** IDENTITY.md or MEMORY.md, opened in the system's editor. */
  identity: () => request<{ content: string; sha256: string | null }>('/api/profile/identity'),
  saveIdentity: (content: string, baseSha256: string | null) =>
    request<{ content: string; sha256: string | null }>('/api/profile/identity', { method: 'PUT', body: JSON.stringify({ content, baseSha256 }) }),
  openProfile: (name: 'identity' | 'memory') => request<void>(`/api/profile/${name}/open`, { method: 'POST' }),
  /** The user's own hand on one block: its words, or a tick in its check box. */
  patchBlock: (paperId: string, blockId: string, change: { text: string } | { done: boolean }) =>
    request<Paper>(`/api/papers/${paperId}/blocks/${blockId}`, { method: 'PATCH', body: JSON.stringify(change) }),
  /** The whole paper typed freehand in one piece: read back into blocks, saved at once. */
  rewriteText: (paperId: string, text: string) =>
    request<Paper>(`/api/papers/${paperId}/text`, { method: 'PUT', body: JSON.stringify({ text }) }),
  /** Opens an item's search in the system browser; the URL comes back for when that cannot happen here. */
  openLink: (paperId: string, blockId: string) =>
    request<{ url: string }>(`/api/papers/${paperId}/blocks/${blockId}/open`, { method: 'POST' }),
  /** The live conversation socket. */
  wsUrl: () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`,
  /** A new conversation on purpose: what was said goes, papers stay. */
  restartChat: () => request<{ ok: true }>('/api/chat/restart', { method: 'POST' }),
};

export type OnboardingState = { step: number; draft: Record<string, unknown>; completedAt: string | null };
export type ProposalResponse = { name: string | null; reason?: string } | null;
