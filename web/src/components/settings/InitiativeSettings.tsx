import { useState } from 'react';
import { BellRing } from 'lucide-react';
import type { InitiativeSettings, SettingsUpdate } from '@shared/protocol';
import { Button } from '@/components/ui/button';
import { requestReachOutPermission } from '@/hooks/useReachOut';
import { cn } from '@/lib/utils';

export type InitiativeDraft = Pick<InitiativeSettings, 'mode' | 'notify'>;

export const initiativeDraftFrom = (s: InitiativeSettings | undefined): InitiativeDraft => ({
  mode: s?.mode ?? 'occasional', notify: s?.notify ?? true,
});

export const initiativePatch = (d: InitiativeDraft): SettingsUpdate['initiative'] => ({ ...d });

const MODES: { value: InitiativeDraft['mode']; label: string; hint: string }[] = [
  { value: 'off', label: '不打扰', hint: '她永远不会先开口，只有你先说话她才回。' },
  { value: 'occasional', label: '偶尔', hint: '想起你说过的重要的事，或者很久没聊了，她会先开口。早上不会主动问好，23:00–08:00 安静。' },
  { value: 'often', label: '经常', hint: '包括早上问好在内，她会更常先开口。' },
];

const permissionNow = () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

function Switch({ id, checked, onChange, label }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button id={id} type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
      className={cn('relative h-5 w-9 flex-none rounded-full border transition-colors',
        checked ? 'border-primary/60 bg-primary/30' : 'border-border bg-wash')}>
      <span className={cn('absolute top-0.5 size-3.5 rounded-full transition-[left,background-color]',
        checked ? 'left-[18px] bg-primary' : 'left-0.5 bg-muted-foreground')} />
    </button>
  );
}

type Props = { draft: InitiativeDraft; name: string; onChange: (d: InitiativeDraft) => void };

/** When and how often she may speak first. */
export function InitiativeSettingsSection({ draft, name, onChange }: Props) {
  const [permission, setPermission] = useState(permissionNow);
  const set = (patch: Partial<InitiativeDraft>) => onChange({ ...draft, ...patch });

  return (
    <section className="grid gap-3.5 rounded-md border border-border p-3.5" aria-labelledby="initiative-title">
      <div>
        <h3 id="initiative-title" className="text-sm font-medium text-foreground">主动找你</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {name || 'Ta'} 会在想起你说过的事、早上、或者很久没聊的时候先开口。也可以让她不打扰你。
        </p>
      </div>

      <div role="radiogroup" aria-labelledby="initiative-title" className="grid gap-1.5">
        {MODES.map(({ value, label, hint }) => (
          <button key={value} type="button" role="radio" aria-checked={draft.mode === value} onClick={() => set({ mode: value })}
            className={cn('grid gap-0.5 rounded-md border p-2.5 text-left transition-colors',
              draft.mode === value ? 'border-primary/60 bg-primary/5' : 'border-border hover:border-muted-foreground/40')}>
            <span className={cn('text-sm', draft.mode === value ? 'text-primary' : 'text-foreground')}>{label}</span>
            <span className="text-xs text-muted-foreground">{hint}</span>
          </button>
        ))}
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
    </section>
  );
}
