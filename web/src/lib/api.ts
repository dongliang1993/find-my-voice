import type { AppStatus, Comfort, HeardAlias, PublicSettings, Rhythm, SettingsUpdate } from '@shared/protocol';

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
  /** The live conversation socket. */
  wsUrl: () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`,
};

export type OnboardingState = { step: number; draft: Record<string, unknown>; completedAt: string | null };
export type ProposalResponse = { name: string | null; reason?: string } | null;
