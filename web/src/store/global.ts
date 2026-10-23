import { create } from 'zustand';
import { api, type AppStatus, type OnboardingState } from '@/lib/api';

type Global = {
  /** The page's first fetch has landed; the console may be shown. */
  ready: boolean;
  status: AppStatus | null;
  /** Null until the first fetch lands, so "not loaded yet" and "no record" stay apart. */
  onboarding: OnboardingState | null;
  /**
   * The page's first fetch. `ready` flips in the same state object as the
   * data: a frame with `ready` but no `onboarding` would flash the console
   * before the first meeting. A failed call still counts — an offline console
   * beats a bar that never fills. Concurrent callers share one request, so
   * StrictMode's double effect does not fetch twice.
   */
  checkReady: () => Promise<void>;
  /** Re-reads the status alone, after settings or the first meeting change it. */
  refreshStatus: () => Promise<void>;
  /** The first meeting is over for good; it may not come back. */
  markOnboarded: () => void;
};

let inflight: Promise<void> | null = null;

const readStatus = () => api.status().catch(() => null);

export const useGlobal = create<Global>()(set => ({
  ready: false,
  status: null,
  onboarding: null,
  checkReady: () => {
    inflight ??= Promise.all([readStatus(), api.onboarding().catch(() => null)])
      .then(([status, onboarding]) => set({ status, onboarding, ready: true }))
      .finally(() => { inflight = null; });
    return inflight;
  },
  refreshStatus: async () => set({ status: await readStatus() }),
  markOnboarded: () => set(state => ({
    onboarding: { step: state.onboarding?.step ?? 0, draft: {}, completedAt: new Date().toISOString() },
  })),
}));
