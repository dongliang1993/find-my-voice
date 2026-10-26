import { useState } from 'react';
import type { InitiativeSettings } from '@shared/protocol';
import { requestReachOutPermission } from '@/hooks/useReachOut';
import { choice } from '@/components/settings/choice';
import { cn } from '@/lib/utils';
import { useSay, useUi, type Said } from '@/lib/locale';

export type InitiativeDraft = Pick<InitiativeSettings, 'mode' | 'notify'>;

export const initiativeDraftFrom = (s: InitiativeSettings | undefined): InitiativeDraft => ({
  mode: s?.mode ?? 'occasional', notify: s?.notify ?? true,
});

const MODES: { value: InitiativeDraft['mode']; label: Said; hint: Said }[] = [
  { value: 'off', label: { zh: '不打扰', en: 'Never' }, hint: { zh: '她永远不会先开口，只有你先说话她才回。', en: 'She never speaks first; she only answers when you do.' } },
  { value: 'occasional', label: { zh: '偶尔', en: 'Now and then' }, hint: { zh: '想起你说过的有日子的事（面试、搬家），她会先问一句；熟了以后，偶尔说起她还记着的一句话。23:00–08:00 安静。', en: 'When something you mentioned has a date (an interview, a move), she asks first; once you know each other, she sometimes brings up a line she remembers. Quiet 23:00–08:00.' } },
  { value: 'often', label: { zh: '经常', en: 'Often' }, hint: { zh: '在此之上，她会在你常聊天的时段打个招呼。', en: 'On top of that, she says hello around the times you usually talk.' } },
];

const permissionNow = () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

function Switch({ id, checked, onChange }: { id: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button id={id} type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
      className={cn('relative h-5 w-9 flex-none rounded-full border transition-colors',
        checked ? 'border-primary/50 bg-primary/15' : 'border-border bg-wash')}>
      <span className={cn('absolute top-0.5 size-3.5 rounded-full transition-[left,background-color]',
        checked ? 'left-[18px] bg-primary' : 'left-0.5 bg-muted-foreground/60')} />
    </button>
  );
}

type Props = { draft: InitiativeDraft; onChange: (d: InitiativeDraft) => void };

/** When she may speak first: one list, and only the chosen line explained. */
export function InitiativeSettingsSection({ draft, onChange }: Props) {
  const ui = useUi();
  const say = useSay();
  const [permission, setPermission] = useState(permissionNow);
  const set = (patch: Partial<InitiativeDraft>) => onChange({ ...draft, ...patch });

  return (
    <section className="grid gap-2" aria-labelledby="initiative-title">
      <h3 id="initiative-title" className="text-[14px] text-foreground">{say('主动找你', 'Reaching out')}</h3>
      <div role="radiogroup" aria-labelledby="initiative-title" className="grid gap-1">
        {MODES.map(({ value, label, hint }) => {
          const on = draft.mode === value;
          return (
            <button key={value} type="button" role="radio" aria-checked={on} onClick={() => set({ mode: value })}
              className={cn(choice(on, 'row'), 'grid grid-cols-[auto_1fr] items-baseline gap-x-2.5 gap-y-1')}>
              {/* A ring that fills: the rows read as one choice among three, not as text. */}
              <span aria-hidden="true" className={cn('grid size-3.5 translate-y-[2px] place-items-center rounded-full border transition-colors',
                on ? 'border-primary' : 'border-muted-foreground/40')}>
                <span className={cn('size-1.5 rounded-full bg-primary transition-transform duration-200', on ? 'scale-100' : 'scale-0')} />
              </span>
              <span>{label[ui]}</span>
              {on && <span className="col-start-2 text-[13px] leading-relaxed text-muted-foreground">{hint[ui]}</span>}
            </button>
          );
        })}
      </div>

      {draft.mode !== 'off' && (
        <div className="mt-2 flex items-center justify-between gap-4">
          <label htmlFor="initiative-notify" className="text-[14px] text-foreground">{say('页面没开着时发系统通知', 'Notify me when the app is closed')}</label>
          <Switch id="initiative-notify" checked={draft.notify} onChange={notify => set({ notify })} />
        </div>
      )}
      {draft.mode !== 'off' && draft.notify && permission === 'default' && (
        <button type="button" className="justify-self-start text-[13px] text-primary hover:underline"
          onClick={async () => setPermission(await requestReachOutPermission())}>
          {say('允许浏览器通知', 'Allow notifications')}
        </button>
      )}
      {draft.mode !== 'off' && draft.notify && permission === 'denied' && (
        <p className="text-[13px] text-muted-foreground">{say('浏览器通知已被拒绝，可以在地址栏左侧的网站设置里重新打开。', 'Notifications are blocked. You can turn them back on in the site settings left of the address bar.')}</p>
      )}
    </section>
  );
}
