import type { FishModel, PublicSettings, SettingsUpdate, VoiceProviderId } from '@shared/protocol';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/settings/Field';
import { cn } from '@/lib/utils';

type Provider = Exclude<VoiceProviderId, 'fixture'>;

export type VoiceDraft = {
  provider: Provider;
  volcengine: { apiKey: string; voiceId: string; resourceId: string };
  fish: { apiKey: string; referenceId: string; model: FishModel };
};

const PROVIDERS: { id: Provider; label: string; blurb: string }[] = [
  { id: 'fish', label: 'Fish Audio', blurb: '音色多，可以用别人分享的声音，也能克隆你喜欢的声音。' },
  { id: 'volcengine', label: '火山引擎', blurb: '豆包语音合成，中文自然，需要开通「语音合成大模型」。' },
];

const FISH_MODELS: { id: FishModel; label: string }[] = [
  { id: 's1', label: 'S1 · 最自然' },
  { id: 's1-mini', label: 'S1 mini · 更快' },
  { id: 'speech-1.6', label: 'Speech 1.6' },
  { id: 'speech-1.5', label: 'Speech 1.5' },
];

export function draftFrom(settings: PublicSettings | null): VoiceDraft {
  return {
    provider: settings?.voice.provider === 'volcengine' ? 'volcengine' : 'fish',
    volcengine: { apiKey: '', voiceId: settings?.voice.volcengine.voiceId ?? '', resourceId: settings?.voice.volcengine.resourceId ?? '' },
    fish: { apiKey: '', referenceId: settings?.voice.fish.referenceId ?? '', model: settings?.voice.fish.model ?? 's1' },
  };
}

/** Saving activates the shown provider and sends only what was filled in; blanks never clear a saved value. */
export function patchFrom(draft: VoiceDraft): SettingsUpdate['voice'] {
  const keep = <T extends Record<string, string>>(fields: T) =>
    Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v)) as Partial<T>;
  return draft.provider === 'fish'
    ? { provider: 'fish', fish: { ...keep({ apiKey: draft.fish.apiKey, referenceId: draft.fish.referenceId }), model: draft.fish.model } }
    : { provider: 'volcengine', volcengine: keep(draft.volcengine) };
}

type Props = { draft: VoiceDraft; settings: PublicSettings | null; onChange: (draft: VoiceDraft) => void };

export function VoiceSettings({ draft, settings, onChange }: Props) {
  const active = settings?.voice.provider;
  const saved = (p: Provider) => settings?.voice[p].hasApiKey ?? false;
  const setFish = (patch: Partial<VoiceDraft['fish']>) => onChange({ ...draft, fish: { ...draft.fish, ...patch } });
  const setVolc = (patch: Partial<VoiceDraft['volcengine']>) => onChange({ ...draft, volcengine: { ...draft.volcengine, ...patch } });
  const current = PROVIDERS.find(p => p.id === draft.provider)!;

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="语音服务商">
        {PROVIDERS.map(p => (
          <button key={p.id} type="button" role="radio" aria-checked={draft.provider === p.id}
            onClick={() => onChange({ ...draft, provider: p.id })}
            className={cn(
              'flex flex-col items-start gap-1 rounded-md border px-3 py-2.5 text-left transition-colors',
              draft.provider === p.id ? 'border-primary/60 bg-primary/5' : 'border-border hover:bg-white/3',
            )}>
            <span className={cn('text-sm font-medium', draft.provider === p.id ? 'text-primary' : 'text-foreground')}>{p.label}</span>
            <span className="label-mono flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className={cn('size-1.5 rounded-full', active === p.id ? 'bg-primary' : saved(p.id) ? 'bg-muted-foreground' : 'bg-white/15')} />
              {active === p.id ? 'In use' : saved(p.id) ? 'Key saved' : 'Not set'}
            </span>
          </button>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">{current.blurb}</p>

      {draft.provider === 'fish' ? <>
        <Field id="fish-key" label="API Key" link="https://fish.audio/app/api-keys/">
          <Input id="fish-key" type="password" value={draft.fish.apiKey} onChange={e => setFish({ apiKey: e.target.value })}
            placeholder={saved('fish') ? '已保存，留空不修改' : 'Fish Audio API Key'} autoComplete="off" required={!saved('fish')} />
        </Field>
        <Field id="fish-voice" label="音色 ID" optional link="https://fish.audio/discovery/" linkLabel="去挑一个声音">
          <Input id="fish-voice" value={draft.fish.referenceId} onChange={e => setFish({ referenceId: e.target.value })}
            placeholder="音色页地址里的那串 ID；留空用默认声音" spellCheck={false} />
        </Field>
        <Field id="fish-model" label="模型">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby="fish-model-label">
            {FISH_MODELS.map(m => (
              <button key={m.id} type="button" role="radio" aria-checked={draft.fish.model === m.id} onClick={() => setFish({ model: m.id })}
                className={cn('rounded-full border px-3 py-1 text-xs transition-colors',
                  draft.fish.model === m.id ? 'border-primary/60 text-primary' : 'border-border text-muted-foreground hover:text-foreground')}>
                {m.label}
              </button>
            ))}
          </div>
        </Field>
      </> : <>
        <Field id="volc-key" label="API Key" link="https://console.volcengine.com/speech/new/setting/apikeys">
          <Input id="volc-key" type="password" value={draft.volcengine.apiKey} onChange={e => setVolc({ apiKey: e.target.value })}
            placeholder={saved('volcengine') ? '已保存，留空不修改' : '火山引擎 API Key'} autoComplete="off" required={!saved('volcengine')} />
        </Field>
        <Field id="volc-voice" label="音色 ID">
          <Input id="volc-voice" value={draft.volcengine.voiceId} onChange={e => setVolc({ voiceId: e.target.value })} spellCheck={false} />
        </Field>
        <Field id="volc-resource" label="资源 ID">
          <Input id="volc-resource" value={draft.volcengine.resourceId} onChange={e => setVolc({ resourceId: e.target.value })} spellCheck={false} />
        </Field>
      </>}
    </div>
  );
}
