import type { AppStatus, Comfort, HeardAlias, Letter, Note, PublicSettings, Rhythm, SettingsUpdate } from '@shared/protocol';

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
  /** Marks a letter read; the server tells every page. */
  openLetter: (id: string) => request<Letter>(`/api/letters/${id}/open`, { method: 'POST' }),
  deleteLetter: (id: string) => fetch(`/api/letters/${id}`, { method: 'DELETE' }).then(r => { if (!r.ok) throw new Error('删不掉这封信'); }),
  /** A letter that broke off, written again. */
  rewriteLetter: (id: string) => fetch(`/api/letters/${id}/rewrite`, { method: 'POST' }).then(r => r.ok),
  /** The note on the table, closed: it is gone, nothing kept. */
  closeNote: () => fetch('/api/note', { method: 'DELETE' }).then(r => { if (!r.ok) throw new Error('收不走这张便签'); }),
  /** The note kept: signed, it is a letter in the inbox. */
  fileNote: () => request<Letter>('/api/note/file', { method: 'POST' }),
  /** IDENTITY.md or MEMORY.md, opened in the system's editor. */
  identity: () => request<{ content: string; sha256: string | null }>('/api/profile/identity'),
  saveIdentity: (content: string, baseSha256: string | null) =>
    request<{ content: string; sha256: string | null }>('/api/profile/identity', { method: 'PUT', body: JSON.stringify({ content, baseSha256 }) }),
  openProfile: (name: 'identity' | 'memory') => request<void>(`/api/profile/${name}/open`, { method: 'POST' }),
  /** The user's own hand on one block of the note: its words, or a tick in its check box. */
  patchNoteBlock: (blockId: string, change: { text: string } | { done: boolean }) =>
    request<Note>(`/api/note/blocks/${blockId}`, { method: 'PATCH', body: JSON.stringify(change) }),
  /** The whole card typed freehand in one piece: read back into blocks, saved at once. */
  rewriteNoteText: (text: string) =>
    request<Note>('/api/note/text', { method: 'PUT', body: JSON.stringify({ text }) }),
  /** Opens an item's search in the system browser; the URL comes back for when that cannot happen here. */
  openLetterLink: (letterId: string, blockId: string) =>
    request<{ url: string }>(`/api/letters/${letterId}/blocks/${blockId}/open`, { method: 'POST' }),
  /** The live conversation socket. */
  wsUrl: () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`,
};

export type OnboardingState = { step: number; draft: Record<string, unknown>; completedAt: string | null };
export type ProposalResponse = { name: string | null; reason?: string } | null;
