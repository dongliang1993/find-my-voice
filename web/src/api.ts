import type { AppStatus, PublicSettings, SettingsUpdate } from '@shared/protocol';

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
};
