import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import type { AppStatus, BrainSource, PublicSettings, ReplyLanguage, SettingsUpdate } from '@shared/protocol';
import { api } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field } from '@/components/settings/Field';
import { choice } from '@/components/settings/choice';
import { usePending } from '@/components/settings/usePending';
import { ReplyLanguagePicker } from '@/components/settings/ReplyLanguagePicker';
import { draftFrom, patchFrom, voiceUsable, VoiceSettings, type VoiceDraft, type When } from '@/components/settings/VoiceSettings';
import { initiativeDraftFrom, InitiativeSettingsSection, type InitiativeDraft } from '@/components/settings/InitiativeSettings';
import { useGlobal } from '@/store/global';
import { AppSheet, type Frame, type Presence } from '@/features/dock/AppSheet';
import { PANEL } from '@/features/dock/appSwitch';
import { useSay, useUi, useWords, type Said } from '@/lib/locale';
import { cn } from '@/lib/utils';
import { useScrollFade } from '@/hooks/useScrollFade';

type Preset = { id: string; label: Said; baseUrl: string; model: string; hint: Said; keyUrl: string };
const same = (text: string): Said => ({ zh: text, en: text });
// Anthropic-compatible endpoints. Users pick one and paste a key; nothing else to look up.
const PRESETS: Preset[] = [
  { id: 'anthropic', label: same('Anthropic'), baseUrl: '', model: '', hint: { zh: '以 sk-ant- 开头', en: 'Starts with sk-ant-' }, keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'deepseek', label: same('DeepSeek'), baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-chat', hint: same('DeepSeek API Key'), keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'kimi', label: same('Kimi'), baseUrl: 'https://api.moonshot.cn/anthropic', model: 'kimi-k2-turbo-preview', hint: same('Moonshot API Key'), keyUrl: 'https://platform.moonshot.cn/console/api-keys' },
  { id: 'glm', label: { zh: '智谱 GLM', en: 'Zhipu GLM' }, baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-4.6', hint: { zh: '智谱 API Key', en: 'Zhipu API Key' }, keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { id: 'custom', label: { zh: '自定义', en: 'Custom' }, baseUrl: '', model: '', hint: { zh: '任意 Anthropic 兼容网关', en: 'Any Anthropic-compatible gateway' }, keyUrl: '' },
];

/** The saved base URL says which preset it was; anything unknown is a custom gateway. */
const presetFor = (baseUrl: string) =>
  PRESETS.find(p => p.id !== 'custom' && p.baseUrl === baseUrl) ?? PRESETS.at(-1)!;

const SOURCE_LABEL: Record<BrainSource, Said> = {
  app: { zh: '使用在这里填写的 Key', en: 'Using the key entered here' },
  'claude-code': { zh: '沿用你的 Claude Code 配置', en: 'Using your Claude Code setup' },
  environment: { zh: '沿用环境变量里的 Key', en: 'Using the key from your environment' },
  none: { zh: '还没有可用的模型', en: 'No model available yet' },
};

/** Typing is saved once it pauses this long. */
const PAUSE_MS = 600;
const SAVED_MS = 2000;

type Page = 'brain' | 'voice' | 'her';
type Brain = { preset: Preset; baseUrl: string; apiKey: string; model: string };
type Identity = { content: string; sha256: string | null };

type Props = { status: AppStatus; stamp: number; frame: Frame | null; presence: Presence; onClose: () => void };

/**
 * Settings, on the same paper as her letters: a sheet slid out of the
 * corner the switcher lives in, a page per subject down its left edge.
 * There is no save button — every change keeps itself, and a quiet
 * 「已保存」 beside the close button says so.
 */
export function SettingsPanel({ status, stamp, frame, presence, onClose }: Props) {
  const word = useWords();
  const ui = useUi();
  const say = useSay();
  const refreshStatus = useGlobal(store => store.refreshStatus);
  const [page, setPage] = useState<Page>(status.brain.ready ? (status.voice.ready ? 'her' : 'voice') : 'brain');
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [brain, setBrain] = useState<Brain>({ preset: PRESETS[0]!, baseUrl: '', apiKey: '', model: '' });
  const [voice, setVoice] = useState<VoiceDraft>(() => draftFrom(null));
  const [name, setName] = useState(status.companionName);
  const [language, setLanguage] = useState<ReplyLanguage>('auto');
  const [initiative, setInitiative] = useState<InitiativeDraft>(() => initiativeDraftFrom(undefined));
  const [identity, setIdentity] = useState<Identity | null>(null);
  /** The sha the next identity save is made against; a ref, so back-to-back saves chain. */
  const identityBase = useRef<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);
  const loaded = useRef(false);
  const { schedule, flush } = usePending();
  const fade = useScrollFade<HTMLDivElement>();

  // Read again whenever the settings change elsewhere — she may have changed one because she was asked to.
  useEffect(() => {
    api.settings()
      .then(s => {
        setSettings(s);
        setName(s.companion.name);
        setLanguage(s.companion.language);
        setInitiative(initiativeDraftFrom(s.initiative));
        // She only ever changes language and initiative; the pages with keys half-typed are left alone.
        if (loaded.current) return;
        loaded.current = true;
        setVoice(draftFrom(s));
        setBrain({ preset: presetFor(s.brain.baseUrl), baseUrl: s.brain.baseUrl, apiKey: '', model: s.brain.model });
      })
      .catch(() => toast.error(say('读取设置失败', 'Could not read settings')));
  }, [stamp]);

  useEffect(() => {
    api.identity()
      .then(doc => { identityBase.current = doc.sha256; setIdentity(doc); })
      .catch(() => toast.error(say('读取性格失败', 'Could not read her character')));
  }, []);

  useEffect(() => {
    if (!savedAt) return;
    const timer = setTimeout(() => setSavedAt(0), SAVED_MS);
    return () => clearTimeout(timer);
  }, [savedAt]);

  const saved = () => { setSavedAt(Date.now()); void refreshStatus(); };

  const save = async (patch: SettingsUpdate) => {
    try {
      const next = await api.saveSettings(patch);
      setSettings(next);
      saved();
      return next;
    } catch (error) {
      toast.error((error as Error).message);
      return null;
    }
  };

  // ---- 大脑 ----
  const brainUsable = (b: Brain) => Boolean(b.apiKey.trim() || settings?.brain.hasApiKey);
  const editBrain = (next: Brain, when: When) => {
    setBrain(next);
    // A preset without a key would point a working setup at a gateway it cannot use.
    if (!brainUsable(next)) return;
    schedule('brain', async () => {
      const key = next.apiKey.trim();
      const done = await save({ brain: { baseUrl: next.baseUrl.trim(), model: next.model.trim(), ...(key ? { apiKey: key } : {}) } });
      if (done && key) setBrain(b => (b.apiKey === next.apiKey ? { ...b, apiKey: '' } : b));
    }, when === 'now' ? 0 : when === 'pause' ? PAUSE_MS : undefined);
  };

  // ---- 声音 ----
  const editVoice = (next: VoiceDraft, when: When) => {
    setVoice(next);
    // Showing a provider is not choosing it: it only becomes hers once it has a key.
    if (!voiceUsable(next, settings)) return;
    schedule('voice', async () => {
      const typed = next[next.provider].apiKey;
      const done = await save({ voice: patchFrom(next) });
      if (done && typed) {
        setVoice(v => (v[next.provider].apiKey === typed ? { ...v, [next.provider]: { ...v[next.provider], apiKey: '' } } : v));
      }
    }, when === 'now' ? 0 : when === 'pause' ? PAUSE_MS : undefined);
  };

  // ---- Ta ----
  const editName = (value: string) => {
    setName(value);
    if (!value.trim()) return;
    schedule('name', () => void save({ companion: { name: value.trim() } }), PAUSE_MS);
  };
  const editLanguage = (value: ReplyLanguage) => {
    setLanguage(value);
    void save({ companion: { language: value } });
  };
  const editInitiative = (value: InitiativeDraft) => {
    setInitiative(value);
    void save({ initiative: value });
  };
  const editIdentity = (content: string) => {
    setIdentity(doc => (doc ? { ...doc, content } : doc));
    if (!content.trim()) return;
    schedule('identity', async () => {
      try {
        const doc = await api.saveIdentity(content, identityBase.current);
        identityBase.current = doc.sha256;
        saved();
      } catch (error) {
        // Most likely the file was edited elsewhere in the meantime: show that one rather than overwrite it.
        toast.error((error as Error).message);
        const doc = await api.identity().catch(() => null);
        if (doc) { identityBase.current = doc.sha256; setIdentity(doc); }
      }
    }, PAUSE_MS);
  };

  const pages: [Page, string, boolean][] = [['brain', word('brain'), status.brain.ready], ['voice', word('voice'), status.voice.ready], ['her', name.trim() || status.companionName, true]];

  return (
    <AppSheet title={word('settings')} frame={frame} presence={presence} onClose={onClose} actions={
      // Next to the close button, where the eye already goes once a change is made.
      <AnimatePresence>
        {savedAt > 0 && (
          <motion.p key={savedAt} role="status" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={PANEL} className="pointer-events-none mr-1 text-[13px] text-muted-foreground">
            {word('saved')}
          </motion.p>
        )}
      </AnimatePresence>
    }>

      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav aria-label={word('settings')} className="flex flex-none gap-1 px-5 pt-3 sm:w-36 sm:flex-col sm:px-4 sm:pt-5">
          {pages.map(([id, label, ok]) => (
            <button key={id} type="button" aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}
              className={cn(choice(page === id, 'row'), 'flex items-center justify-between gap-2')}>
              {label}
              {!ok && <span className="size-1.5 rounded-full bg-primary" aria-label={word('unset')} />}
            </button>
          ))}
        </nav>

        {/* Room under the last item: 40px on a desktop; on a phone, clear of the switcher too. */}
        <div ref={fade} className="scroll-fade min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-28 text-[14px] sm:pb-10 sm:pl-4">
          <p className="letter mb-5 text-[13px] text-muted-foreground italic">{word('tellHer')}</p>
          {page === 'brain' && (
            <div className="grid gap-5">
              <p className={cn('flex items-center gap-2', status.brain.ready ? 'text-foreground' : 'text-primary')}>
                <span className={cn('size-1.5 rounded-full', status.brain.ready ? 'bg-foreground/50' : 'bg-primary')} />
                {SOURCE_LABEL[status.brain.source][ui]}
              </p>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={say('服务商', 'Provider')}>
                {PRESETS.map(p => (
                  <button key={p.id} type="button" role="radio" aria-checked={brain.preset.id === p.id}
                    className={choice(brain.preset.id === p.id)}
                    onClick={() => editBrain({ ...brain, preset: p, baseUrl: p.id === 'custom' ? brain.baseUrl : p.baseUrl, model: p.model }, p.id === 'custom' ? 'leave' : 'now')}>
                    {p.label[ui]}
                  </button>
                ))}
              </div>
              {brain.preset.id === 'custom' && (
                <Field id="brain-url" label="Base URL">
                  <Input id="brain-url" value={brain.baseUrl} onChange={e => editBrain({ ...brain, baseUrl: e.target.value }, 'pause')}
                    placeholder="https://…/anthropic" inputMode="url" />
                </Field>
              )}
              <Field id="brain-key" label="API Key" link={brain.preset.keyUrl || undefined}>
                <Input id="brain-key" type="password" autoComplete="off" value={brain.apiKey}
                  onChange={e => editBrain({ ...brain, apiKey: e.target.value }, 'leave')}
                  onBlur={() => flush('brain')} onKeyDown={e => { if (e.key === 'Enter') flush('brain'); }}
                  placeholder={settings?.brain.hasApiKey ? word('saved') : brain.preset.hint[ui]} />
              </Field>
              <Field id="brain-model" label={say('模型', 'Model')}>
                <Input id="brain-model" value={brain.model} onChange={e => editBrain({ ...brain, model: e.target.value }, 'pause')}
                  placeholder={say('默认', 'Default')} />
              </Field>
              <p className="text-[13px] text-muted-foreground">{say('所有凭证只保存在你本机的 ~/.find-my-voice。', 'Every key stays on this machine, in ~/.find-my-voice.')}</p>
            </div>
          )}

          {page === 'voice' && (
            <VoiceSettings draft={voice} settings={settings} onChange={editVoice} onLeave={() => flush('voice')} />
          )}

          {page === 'her' && (
            <div className="grid gap-6">
              <Field id="her-identity" label={say('性格', 'Character')}>
                <Textarea id="her-identity" value={identity?.content ?? ''} disabled={!identity}
                  onChange={e => editIdentity(e.target.value)} onBlur={() => flush('identity')}
                  className="max-h-[40dvh] min-h-32 resize-none text-[14px] leading-relaxed" />
              </Field>
              <Field id="her-name" label={say('名字', 'Name')}>
                <Input id="her-name" value={name} maxLength={40} onChange={e => editName(e.target.value)} onBlur={() => flush('name')} />
              </Field>
              <ReplyLanguagePicker value={language} onChange={editLanguage} />
              <InitiativeSettingsSection draft={initiative} onChange={editInitiative} />
              <details className="group">
                <summary className="cursor-pointer list-none text-[13px] text-muted-foreground hover:text-foreground">
                  {say('高级', 'Advanced')}
                </summary>
                <div className="mt-3 grid gap-2 text-[13px]">
                  {([['identity', 'IDENTITY.md'], ['memory', 'MEMORY.md']] as const).map(([doc, file]) => (
                    <p key={doc} className="flex items-baseline gap-3">
                      <span className="text-muted-foreground">{file}</span>
                      <button type="button" className="text-primary hover:underline"
                        onClick={() => api.openProfile(doc).catch(error => toast.error((error as Error).message))}>
                        {say('在编辑器中打开', 'Open in editor')}
                      </button>
                    </p>
                  ))}
                </div>
              </details>
            </div>
          )}
        </div>
      </div>
    </AppSheet>
  );
}
