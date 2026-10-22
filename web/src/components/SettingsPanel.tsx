import { useEffect, useState, type SubmitEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { AppStatus, BrainSource, PublicSettings } from '@shared/protocol';
import { api } from '@/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Field } from '@/components/settings/Field';
import { draftFrom, patchFrom, VoiceSettings, type VoiceDraft } from '@/components/settings/VoiceSettings';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { cn } from '@/lib/utils';

type Preset = { id: string; label: string; baseUrl: string; model: string; hint: string; keyUrl: string };
// Anthropic-compatible endpoints. Users pick one and paste a key; nothing else to look up.
const PRESETS: Preset[] = [
  { id: 'anthropic', label: 'Anthropic', baseUrl: '', model: '', hint: '官方 API Key，以 sk-ant- 开头', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-chat', hint: 'DeepSeek 开放平台的 API Key', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'kimi', label: 'Kimi', baseUrl: 'https://api.moonshot.cn/anthropic', model: 'kimi-k2-turbo-preview', hint: 'Moonshot 开放平台的 API Key', keyUrl: 'https://platform.moonshot.cn/console/api-keys' },
  { id: 'glm', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-4.6', hint: '智谱开放平台的 API Key', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { id: 'custom', label: '自定义', baseUrl: '', model: '', hint: '任意 Anthropic 兼容网关', keyUrl: '' },
];

const SOURCE_LABEL: Record<BrainSource, string> = {
  app: '使用在这里填写的 Key',
  'claude-code': '已沿用你的 Claude Code 配置',
  environment: '已沿用环境变量里的 Key',
  none: '还没有找到可用的模型',
};

type Tab = 'brain' | 'voice' | 'her';
type Props = { open: boolean; status: AppStatus; onOpenChange: (open: boolean) => void; onSaved: () => void };

/** Dialog on desktop, bottom sheet on phones. */
export function SettingsPanel({ open, status, onOpenChange, onSaved }: Props) {
  const desktop = useMediaQuery('(min-width: 640px)');
  const title = '设置';
  const description = '所有凭证只保存在你本机的 ~/.find-my-voice。';
  const body = <SettingsForm status={status} onSaved={onSaved} pane={desktop ? 'dialog' : 'drawer'} />;

  if (desktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[75dvh] flex-col overflow-hidden border-border bg-popover p-0 sm:max-w-xl">
          <DialogHeader className="flex-none p-4">
            <DialogTitle className="text-xl font-medium tracking-wide text-foreground">{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {body}
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="flex max-h-[80dvh] flex-col bg-popover data-[vaul-drawer-direction=bottom]:max-h-[80dvh]">
        <DrawerHeader className="flex-none text-left">
          <DrawerTitle className="text-xl font-medium tracking-wide text-foreground">{title}</DrawerTitle>
          <DrawerDescription>{description}</DrawerDescription>
        </DrawerHeader>
        {body}
      </DrawerContent>
    </Drawer>
  );
}

function SettingsForm({ status, onSaved, pane }: { status: AppStatus; onSaved: () => void; pane: 'dialog' | 'drawer' }) {
  const [tab, setTab] = useState<Tab>(status.brain.ready ? (status.voice.ready ? 'her' : 'voice') : 'brain');
  const [preset, setPreset] = useState<Preset>(PRESETS[0]!);
  const [brain, setBrain] = useState({ baseUrl: '', apiKey: '', model: '' });
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [voice, setVoice] = useState<VoiceDraft>(() => draftFrom(null));
  const [name, setName] = useState(status.companionName);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.settings()
      .then(s => { setSettings(s); setVoice(draftFrom(s)); })
      .catch(() => toast.error('读取设置失败'));
  }, []);

  const pickPreset = (next: Preset) => {
    setPreset(next);
    setBrain(b => ({ ...b, baseUrl: next.baseUrl, model: next.model }));
  };

  const save = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    try {
      const next = tab === 'brain' ? await api.saveSettings({ brain })
        : tab === 'voice' ? await api.saveSettings({ voice: patchFrom(voice) })
        : await api.saveSettings({ companion: { name } });
      // Keep the panel truthful even if it stays open: saved keys become "saved", typed secrets clear.
      setSettings(next);
      setVoice(draftFrom(next));
      toast.success('已保存');
      onSaved();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const tabs: [Tab, string, boolean][] = [['brain', '大脑', status.brain.ready], ['voice', '声音', status.voice.ready], ['her', 'Ta', true]];
  const scrollPad = pane === 'drawer'
    ? 'px-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))]'
    : 'p-4 pt-0';

  return (
    <Tabs value={tab} onValueChange={value => setTab(value as Tab)} className="flex min-h-0 flex-1 flex-col gap-5">
      <TabsList className="mx-4 w-[calc(100%-2rem)] flex-none">
        {tabs.map(([id, label, ok]) => (
          <TabsTrigger key={id} value={id} className="gap-1.5">
            {label}
            {!ok && <span className="size-1.5 rounded-full bg-destructive" aria-label="未配置" />}
          </TabsTrigger>
        ))}
      </TabsList>

      <form id="settings-form" onSubmit={save} className={cn('grid min-h-0 flex-1 content-start gap-5 overflow-y-auto', scrollPad)}>
        <TabsContent value="brain" className="grid gap-4">
          <SourceLine ok={status.brain.ready}>{SOURCE_LABEL[status.brain.source]}</SourceLine>
          <p className="text-sm text-muted-foreground">Ta 用 Claude Agent 驱动，需要一个 Anthropic 或兼容服务的 API Key。</p>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="服务商">
            {PRESETS.map(p => (
              <Button key={p.id} type="button" size="sm" role="radio" aria-checked={preset.id === p.id}
                variant={preset.id === p.id ? 'secondary' : 'outline'}
                className={cn('rounded-full', preset.id === p.id && 'border-primary/60 text-primary')}
                onClick={() => pickPreset(p)}>
                {p.label}
              </Button>
            ))}
          </div>
          {preset.id === 'custom' && (
            <Field id="brain-url" label="Base URL">
              <Input id="brain-url" value={brain.baseUrl} onChange={e => setBrain({ ...brain, baseUrl: e.target.value })} placeholder="https://…/anthropic" inputMode="url" />
            </Field>
          )}
          <Field id="brain-key" label="API Key" link={preset.keyUrl}>
            <Input id="brain-key" type="password" value={brain.apiKey} onChange={e => setBrain({ ...brain, apiKey: e.target.value })}
              placeholder={preset.hint} autoComplete="off" required={!status.brain.ready} />
          </Field>
          <Field id="brain-model" label="模型" optional>
            <Input id="brain-model" value={brain.model} onChange={e => setBrain({ ...brain, model: e.target.value })} placeholder="留空使用默认模型" />
          </Field>
        </TabsContent>

        <TabsContent value="voice" className="grid gap-4">
          <SourceLine ok={status.voice.ready}>{status.voice.ready ? '声音已就绪' : '还不能发语音'}</SourceLine>
          <VoiceSettings draft={voice} settings={settings} onChange={setVoice} />
        </TabsContent>

        <TabsContent value="her" className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            Ta 的性格写在 <code className="rounded bg-muted px-1 py-0.5 text-xs">~/.find-my-voice/IDENTITY.md</code>，
            Ta 对你的了解写在 <code className="rounded bg-muted px-1 py-0.5 text-xs">MEMORY.md</code>。可以直接编辑，下一条消息生效。
          </p>
          <Field id="her-name" label="Ta 的名字">
            <Input id="her-name" value={name} onChange={e => setName(e.target.value)} maxLength={40} required />
          </Field>
        </TabsContent>
      </form>

      <Button type="submit" size="lg" disabled={saving}
        className={cn('flex-none rounded-xl text-base', pane === 'drawer' && 'mx-4 mb-[calc(1.25rem+env(safe-area-inset-bottom))]')}
        form="settings-form">
        {saving && <Loader2 className="animate-spin" />}
        {saving ? '保存中…' : '保存'}
      </Button>
    </Tabs>
  );
}

function SourceLine({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <p className={cn('flex items-center gap-2 text-sm', ok ? 'text-primary' : 'text-destructive')}>
      <span className="size-1.5 rounded-full bg-current" />
      {children}
    </p>
  );
}
