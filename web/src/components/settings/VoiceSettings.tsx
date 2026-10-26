import type { ElevenModel, FishModel, PublicSettings, SettingsUpdate, VoiceProviderId } from '@shared/protocol';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/settings/Field';
import { choice } from '@/components/settings/choice';
import { cn } from '@/lib/utils';
import { useSay, useUi, type Said } from '@/lib/locale';

type Provider = Exclude<VoiceProviderId, 'fixture'>;

export type VoiceDraft = {
  provider: Provider;
  volcengine: { apiKey: string; voiceId: string; resourceId: string };
  fish: { apiKey: string; referenceId: string; model: FishModel };
  elevenlabs: { apiKey: string; voiceId: string; model: ElevenModel; stability: number; similarity: number };
};

const same = (text: string): Said => ({ zh: text, en: text });

const PROVIDERS: { id: Provider; label: Said; blurb: Said }[] = [
  { id: 'fish', label: same('Fish Audio'), blurb: { zh: '音色多，可以用别人分享的声音，也能克隆你喜欢的声音。', en: 'Lots of voices: use ones others have shared, or clone one you like.' } },
  { id: 'elevenlabs', label: same('ElevenLabs'), blurb: { zh: '可以用 Voice Design 按描述捏一个新声音，多语言表现好。', en: 'Shape a new voice from a description with Voice Design; strong across languages.' } },
  { id: 'volcengine', label: { zh: '火山引擎', en: 'Volcengine' }, blurb: { zh: '豆包语音合成，中文自然，需要开通「语音合成大模型」。', en: 'Doubao speech, natural in Chinese. Needs the speech synthesis model enabled.' } },
];

const FISH_MODELS: { id: FishModel; label: Said }[] = [
  { id: 's1', label: { zh: 'S1 · 最自然', en: 'S1 · most natural' } },
  { id: 's1-mini', label: { zh: 'S1 mini · 更快', en: 'S1 mini · faster' } },
  { id: 'speech-1.6', label: same('Speech 1.6') },
  { id: 'speech-1.5', label: same('Speech 1.5') },
];

const ELEVEN_MODELS: { id: ElevenModel; label: Said }[] = [
  { id: 'eleven_v4', label: { zh: 'v4 · 最有表现力', en: 'v4 · most expressive' } },
  { id: 'eleven_v4_turbo', label: { zh: 'v4 Turbo · 更快', en: 'v4 Turbo · faster' } },
  { id: 'eleven_multilingual_v2', label: same('Multilingual v2') },
  { id: 'eleven_flash_v2_5', label: { zh: 'Flash 2.5 · 最便宜', en: 'Flash 2.5 · cheapest' } },
];

const isProvider = (id: VoiceProviderId | undefined): id is Provider => id === 'fish' || id === 'elevenlabs' || id === 'volcengine';

export function draftFrom(settings: PublicSettings | null): VoiceDraft {
  const stored = settings?.voice.provider;
  return {
    provider: isProvider(stored) ? stored : 'fish',
    volcengine: {
      apiKey: '', voiceId: settings?.voice.volcengine.voiceId ?? '',
      resourceId: settings?.voice.volcengine.resourceId ?? '',
    },
    fish: { apiKey: '', referenceId: settings?.voice.fish.referenceId ?? '', model: settings?.voice.fish.model ?? 's1' },
    elevenlabs: {
      apiKey: '', voiceId: settings?.voice.elevenlabs.voiceId ?? '',
      model: settings?.voice.elevenlabs.model ?? 'eleven_v4',
      stability: settings?.voice.elevenlabs.stability ?? 0.5,
      similarity: settings?.voice.elevenlabs.similarity ?? 0.8,
    },
  };
}

/** Saving activates the shown provider and sends only what was filled in; blanks never clear a saved value. */
export function patchFrom(draft: VoiceDraft): SettingsUpdate['voice'] {
  const keep = <T extends Record<string, string>>(fields: T) =>
    Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v)) as Partial<T>;
  switch (draft.provider) {
    case 'fish':
      return { provider: 'fish', fish: { ...keep({ apiKey: draft.fish.apiKey, referenceId: draft.fish.referenceId }), model: draft.fish.model } };
    case 'elevenlabs':
      return {
        provider: 'elevenlabs',
        elevenlabs: {
          ...keep({ apiKey: draft.elevenlabs.apiKey, voiceId: draft.elevenlabs.voiceId }),
          model: draft.elevenlabs.model,
          stability: draft.elevenlabs.stability, similarity: draft.elevenlabs.similarity,
        },
      };
    case 'volcengine':
      return {
        provider: 'volcengine',
        volcengine: keep({ apiKey: draft.volcengine.apiKey, voiceId: draft.volcengine.voiceId, resourceId: draft.volcengine.resourceId }),
      };
  }
}

/** Whether a provider can be switched on: it has a key saved, or one is being typed. */
export const voiceUsable = (draft: VoiceDraft, settings: PublicSettings | null) =>
  Boolean(settings?.voice[draft.provider].hasApiKey || draft[draft.provider].apiKey.trim());

/**
 * How soon an edit is saved: a pick at once, typing after a pause, a key
 * only once its field is left — half a key is not a key.
 */
export type When = 'now' | 'pause' | 'leave';

type Props = {
  draft: VoiceDraft;
  settings: PublicSettings | null;
  onChange: (draft: VoiceDraft, when: When) => void;
  /** A key field was left: whatever is waiting goes now. */
  onLeave: () => void;
};

export function VoiceSettings({ draft, settings, onChange, onLeave }: Props) {
  const ui = useUi();
  const say = useSay();
  const active = settings?.voice.provider;
  const saved = (p: Provider) => settings?.voice[p].hasApiKey ?? false;
  const setFish = (patch: Partial<VoiceDraft['fish']>, when: When) => onChange({ ...draft, fish: { ...draft.fish, ...patch } }, when);
  const setVolc = (patch: Partial<VoiceDraft['volcengine']>, when: When) => onChange({ ...draft, volcengine: { ...draft.volcengine, ...patch } }, when);
  const setEleven = (patch: Partial<VoiceDraft['elevenlabs']>, when: When) => onChange({ ...draft, elevenlabs: { ...draft.elevenlabs, ...patch } }, when);
  const current = PROVIDERS.find(p => p.id === draft.provider)!;
  const keyProps = (p: Provider, placeholder: string) => ({
    type: 'password', autoComplete: 'off', onBlur: onLeave,
    onKeyDown: (event: React.KeyboardEvent) => { if (event.key === 'Enter') onLeave(); },
    placeholder: saved(p) ? say('已保存', 'Saved') : placeholder,
  });

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={say('语音服务商', 'Voice provider')}>
        {PROVIDERS.map(p => (
          <button key={p.id} type="button" role="radio" aria-checked={draft.provider === p.id}
            onClick={() => onChange({ ...draft, provider: p.id }, 'now')}
            className={cn(choice(draft.provider === p.id), 'inline-flex items-center gap-2')}>
            {p.label[ui]}
            {active === p.id && <span className="size-1.5 rounded-full bg-primary" aria-label={say('使用中', 'In use')} />}
          </button>
        ))}
      </div>
      <p className="text-[13px] leading-relaxed text-muted-foreground">{current.blurb[ui]}</p>

      {draft.provider === 'fish' ? <>
        <Field id="fish-key" label="API Key" link="https://fish.audio/app/api-keys/">
          <Input id="fish-key" value={draft.fish.apiKey} onChange={e => setFish({ apiKey: e.target.value }, 'leave')} {...keyProps('fish', 'Fish Audio API Key')} />
        </Field>
        <Field id="fish-voice" label={say('音色 ID', 'Voice ID')} link="https://fish.audio/discovery/" linkLabel={say('去挑一个声音', 'Pick a voice')}>
          <Input id="fish-voice" value={draft.fish.referenceId} onChange={e => setFish({ referenceId: e.target.value }, 'pause')}
            placeholder={say('留空用默认声音', 'Leave empty for the default voice')} spellCheck={false} />
        </Field>
        <Field id="fish-model" label={say('模型', 'Model')}>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby="fish-model-label">
            {FISH_MODELS.map(m => (
              <button key={m.id} type="button" role="radio" aria-checked={draft.fish.model === m.id} onClick={() => setFish({ model: m.id }, 'now')}
                className={choice(draft.fish.model === m.id)}>
                {m.label[ui]}
              </button>
            ))}
          </div>
        </Field>
      </> : draft.provider === 'elevenlabs' ? <>
        <Field id="eleven-key" label="API Key" link="https://elevenlabs.io/app/developers/api-keys">
          <Input id="eleven-key" value={draft.elevenlabs.apiKey} onChange={e => setEleven({ apiKey: e.target.value }, 'leave')} {...keyProps('elevenlabs', 'ElevenLabs API Key')} />
        </Field>
        <Field id="eleven-voice" label={say('音色 ID', 'Voice ID')} link="https://elevenlabs.io/app/voice-lab" linkLabel={say('去捏一个声音', 'Design a voice')}>
          <Input id="eleven-voice" value={draft.elevenlabs.voiceId} onChange={e => setEleven({ voiceId: e.target.value }, 'pause')}
            placeholder={say('My Voices 里那串 ID', 'The ID from My Voices')} spellCheck={false} />
        </Field>
        <Field id="eleven-model" label={say('模型', 'Model')}>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby="eleven-model-label">
            {ELEVEN_MODELS.map(m => (
              <button key={m.id} type="button" role="radio" aria-checked={draft.elevenlabs.model === m.id} onClick={() => setEleven({ model: m.id }, 'now')}
                className={choice(draft.elevenlabs.model === m.id)}>
                {m.label[ui]}
              </button>
            ))}
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field id="eleven-stability" label="Stability">
            <Input id="eleven-stability" type="number" min={0} max={1} step={0.05} value={draft.elevenlabs.stability}
              onChange={e => setEleven({ stability: Number(e.target.value) }, 'pause')} />
          </Field>
          <Field id="eleven-similarity" label="Similarity">
            <Input id="eleven-similarity" type="number" min={0} max={1} step={0.05} value={draft.elevenlabs.similarity}
              onChange={e => setEleven({ similarity: Number(e.target.value) }, 'pause')} />
          </Field>
        </div>
      </> : <>
        <Field id="volc-key" label="API Key" link="https://console.volcengine.com/speech/new/setting/apikeys">
          <Input id="volc-key" value={draft.volcengine.apiKey} onChange={e => setVolc({ apiKey: e.target.value }, 'leave')} {...keyProps('volcengine', say('火山引擎 API Key', 'Volcengine API Key'))} />
        </Field>
        <Field id="volc-voice" label={say('音色 ID', 'Voice ID')}>
          <Input id="volc-voice" value={draft.volcengine.voiceId} onChange={e => setVolc({ voiceId: e.target.value }, 'pause')} spellCheck={false} />
        </Field>
        <Field id="volc-resource" label={say('资源 ID', 'Resource ID')}>
          <Input id="volc-resource" value={draft.volcengine.resourceId} onChange={e => setVolc({ resourceId: e.target.value }, 'pause')} spellCheck={false} />
        </Field>
      </>}
    </div>
  );
}
