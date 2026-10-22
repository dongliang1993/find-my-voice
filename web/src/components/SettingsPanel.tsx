import { useEffect, useState, type SubmitEvent } from 'react';
import { ArrowUpRight, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { AppStatus, BrainSource } from '@shared/protocol';
import { api } from '@/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
  const body = <SettingsForm status={status} onSaved={onSaved} />;

  if (desktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-heading text-2xl font-medium text-mist">{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {body}
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[92dvh] bg-popover">
        <DrawerHeader className="text-left">
          <DrawerTitle className="font-heading text-2xl font-medium text-mist">{title}</DrawerTitle>
          <DrawerDescription>{description}</DrawerDescription>
        </DrawerHeader>
        <div className="overflow-y-auto px-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">{body}</div>
      </DrawerContent>
    </Drawer>
  );
}

function SettingsForm({ status, onSaved }: { status: AppStatus; onSaved: () => void }) {
  const [tab, setTab] = useState<Tab>(status.brain.ready ? (status.voice.ready ? 'her' : 'voice') : 'brain');
  const [preset, setPreset] = useState<Preset>(PRESETS[0]!);
  const [brain, setBrain] = useState({ baseUrl: '', apiKey: '', model: '' });
  const [voice, setVoice] = useState({ apiKey: '', voiceId: '', resourceId: '' });
  const [name, setName] = useState(status.companionName);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.settings()
      .then(s => setVoice(v => ({ ...v, voiceId: s.voice.voiceId, resourceId: s.voice.resourceId })))
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
      if (tab === 'brain') await api.saveSettings({ brain });
      if (tab === 'voice') await api.saveSettings({ voice: {
        ...(voice.apiKey ? { apiKey: voice.apiKey } : {}),
        // Empty means "not loaded"; never overwrite a configured voice with blanks.
        ...(voice.voiceId.trim() ? { voiceId: voice.voiceId.trim() } : {}),
        ...(voice.resourceId.trim() ? { resourceId: voice.resourceId.trim() } : {}),
      } });
      if (tab === 'her') await api.saveSettings({ companion: { name } });
      toast.success('已保存');
      onSaved();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const tabs: [Tab, string, boolean][] = [['brain', '大脑', status.brain.ready], ['voice', '声音', status.voice.ready], ['her', '她', true]];

  return (
    <Tabs value={tab} onValueChange={value => setTab(value as Tab)} className="gap-5">
      <TabsList className="w-full">
        {tabs.map(([id, label, ok]) => (
          <TabsTrigger key={id} value={id} className="gap-1.5">
            {label}
            {!ok && <span className="size-1.5 rounded-full bg-destructive" aria-label="未配置" />}
          </TabsTrigger>
        ))}
      </TabsList>

      <form onSubmit={save} className="grid gap-5">
        <TabsContent value="brain" className="grid gap-4">
          <SourceLine ok={status.brain.ready}>{SOURCE_LABEL[status.brain.source]}</SourceLine>
          <p className="text-sm text-muted-foreground">她用 Claude Agent 驱动，需要一个 Anthropic 或兼容服务的 API Key。</p>
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
          <p className="text-sm text-muted-foreground">语音由火山引擎豆包语音合成。在控制台开通「语音合成大模型」后创建 API Key。</p>
          <Field id="voice-key" label="API Key" link="https://console.volcengine.com/speech/new/setting/apikeys">
            <Input id="voice-key" type="password" value={voice.apiKey} onChange={e => setVoice({ ...voice, apiKey: e.target.value })}
              placeholder={status.voice.ready ? '已保存，留空不修改' : '火山引擎 API Key'} autoComplete="off" />
          </Field>
          <Field id="voice-id" label="音色 ID">
            <Input id="voice-id" value={voice.voiceId} onChange={e => setVoice({ ...voice, voiceId: e.target.value })} />
          </Field>
          <Field id="voice-resource" label="资源 ID">
            <Input id="voice-resource" value={voice.resourceId} onChange={e => setVoice({ ...voice, resourceId: e.target.value })} />
          </Field>
        </TabsContent>

        <TabsContent value="her" className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            她的性格写在 <code className="rounded bg-muted px-1 py-0.5 text-xs">~/.find-my-voice/IDENTITY.md</code>，
            她对你的了解写在 <code className="rounded bg-muted px-1 py-0.5 text-xs">MEMORY.md</code>。可以直接编辑，下一条消息生效。
          </p>
          <Field id="her-name" label="她的名字">
            <Input id="her-name" value={name} onChange={e => setName(e.target.value)} maxLength={40} required />
          </Field>
        </TabsContent>

        <Button type="submit" size="lg" disabled={saving} className="h-11 rounded-xl text-base">
          {saving && <Loader2 className="animate-spin" />}
          {saving ? '保存中…' : '保存'}
        </Button>
      </form>
    </Tabs>
  );
}

function SourceLine({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <p className={cn('flex items-center gap-2 text-sm', ok ? 'text-ok' : 'text-destructive')}>
      <span className="size-1.5 rounded-full bg-current" />
      {children}
    </p>
  );
}

function Field({ id, label, optional, link, children }: { id: string; label: string; optional?: boolean; link?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between">
        <Label htmlFor={id} className="text-muted-foreground">
          {label}
          {optional && <span className="text-xs font-normal text-muted-foreground/70">可选</span>}
        </Label>
        {link && (
          <a href={link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-xs text-primary hover:underline">
            去哪里拿 Key <ArrowUpRight className="size-3" />
          </a>
        )}
      </div>
      {children}
    </div>
  );
}
