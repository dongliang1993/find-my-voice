import { useState } from 'react';
import { BellRing } from 'lucide-react';
import type { InitiativeSettings, SettingsUpdate } from '@shared/protocol';
import { Button } from '@/components/ui/button';
import { requestReachOutPermission } from '@/hooks/useReachOut';
import { cn } from '@/lib/utils';

export type InitiativeDraft = Pick<InitiativeSettings, 'enabled' | 'notify' | 'quietStart' | 'quietEnd' | 'dailyLimit'>;

export const initiativeDraftFrom = (s: InitiativeSettings | undefined): InitiativeDraft => ({
  enabled: s?.enabled ?? true, notify: s?.notify ?? true,
  quietStart: s?.quietStart ?? 23, quietEnd: s?.quietEnd ?? 8, dailyLimit: s?.dailyLimit ?? 3,
});

export const initiativePatch = (d: InitiativeDraft): SettingsUpdate['initiative'] => ({ ...d });

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const permissionNow = () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

function Switch({ id, checked, onChange, label }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button id={id} type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
      className={cn('relative h-5 w-9 flex-none rounded-full border transition-colors',
        checked ? 'border-primary/60 bg-primary/30' : 'border-border bg-white/5')}>
      <span className={cn('absolute top-0.5 size-3.5 rounded-full transition-[left,background-color]',
        checked ? 'left-[18px] bg-primary' : 'left-0.5 bg-muted-foreground')} />
    </button>
  );
}

function HourSelect({ id, value, onChange, disabled }: { id: string; value: number; onChange: (h: number) => void; disabled: boolean }) {
  return (
    <select id={id} value={value} disabled={disabled} onChange={e => onChange(Number(e.target.value))}
      className="h-8 rounded-md border border-input bg-black px-2 font-mono text-sm text-foreground disabled:opacity-50">
      {HOURS.map(h => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
    </select>
  );
}

type Props = { draft: InitiativeDraft; name: string; onChange: (d: InitiativeDraft) => void };

/** When and how often she may speak first. */
export function InitiativeSettingsSection({ draft, name, onChange }: Props) {
  const [permission, setPermission] = useState(permissionNow);
  const set = (patch: Partial<InitiativeDraft>) => onChange({ ...draft, ...patch });
  const off = !draft.enabled;

  return (
    <section className="grid gap-3.5 rounded-md border border-border p-3.5" aria-labelledby="initiative-title">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="initiative-title" className="text-sm font-medium text-foreground">主动找你</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {name || 'Ta'} 会在想起你说过的事、早上、或者很久没聊的时候先开口。也可能选择不打扰你。
          </p>
        </div>
        <Switch id="initiative-enabled" checked={draft.enabled} onChange={enabled => set({ enabled })} label="允许主动找你" />
      </div>

      <div className={cn('grid gap-3 transition-opacity', off && 'pointer-events-none opacity-45')} aria-disabled={off}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor="quiet-start" className="text-sm text-muted-foreground">免打扰</label>
          <div className="flex items-center gap-1.5">
            <HourSelect id="quiet-start" value={draft.quietStart} disabled={off} onChange={quietStart => set({ quietStart })} />
            <span className="text-xs text-muted-foreground">到</span>
            <HourSelect id="quiet-end" value={draft.quietEnd} disabled={off} onChange={quietEnd => set({ quietEnd })} />
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span id="daily-limit-label" className="text-sm text-muted-foreground">每天最多</span>
          <div className="flex gap-1" role="radiogroup" aria-labelledby="daily-limit-label">
            {[1, 2, 3, 5].map(n => (
              <button key={n} type="button" role="radio" aria-checked={draft.dailyLimit === n} disabled={off} onClick={() => set({ dailyLimit: n })}
                className={cn('h-7 min-w-9 rounded-full border px-2 font-mono text-xs transition-colors',
                  draft.dailyLimit === n ? 'border-primary/60 text-primary' : 'border-border text-muted-foreground hover:text-foreground')}>
                {n} 次
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <label htmlFor="initiative-notify" className="text-sm text-muted-foreground">页面没开着时发系统通知</label>
          <Switch id="initiative-notify" checked={draft.notify} onChange={notify => set({ notify })} label="系统通知" />
        </div>

        {permission === 'default' && (
          <Button type="button" variant="outline" size="sm" className="justify-self-start rounded-full"
            onClick={async () => setPermission(await requestReachOutPermission())}>
            <BellRing /> 允许浏览器通知（页面在后台时）
          </Button>
        )}
        {permission === 'denied' && <p className="text-xs text-muted-foreground">浏览器通知已被拒绝，可以在地址栏左侧的网站设置里重新打开。</p>}
      </div>
    </section>
  );
}
