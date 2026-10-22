import { useCallback, useEffect, useState } from 'react';
import { Settings } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { api, type AppStatus } from '@/api';
import { audio } from '@/audio';
import { Composer } from '@/components/Composer';
import { Avatar, DotName } from '@/components/Identity';
import { MessageList } from '@/components/MessageList';
import { SettingsPanel } from '@/components/SettingsPanel';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { useChat } from '@/useChat';
import { usePlaying, useVoiceGlow } from '@/useVoice';
import { cn } from '@/lib/utils';

export function App() {
  const chat = useChat();
  const playing = usePlaying();
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useVoiceGlow();

  const refresh = useCallback(() => api.status().then(setStatus).catch(() => setStatus(null)), []);
  useEffect(() => { void refresh(); }, [refresh]);
  // First visit without a model: open setup straight away.
  useEffect(() => { if (status && !status.brain.ready) setSettingsOpen(true); }, [status]);
  // Any gesture unlocks audio so her first voice message can autoplay.
  useEffect(() => {
    const unlock = () => audio.unlock();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  }, []);
  // Server-side errors surface as toasts.
  useEffect(() => {
    for (const notice of chat.notices) { toast.error(notice.message, { id: notice.id }); chat.dismiss(notice.id); }
  }, [chat.notices, chat.dismiss]);

  const online = chat.connection === 'open';
  const thinking = chat.status === 'thinking';
  const name = status?.companionName ?? '';
  const needsSetup = status !== null && (!status.brain.ready || !status.voice.ready);
  const onAir = playing ? 'SPEAKING' : thinking ? 'THINKING' : online ? 'ONLINE' : 'CONNECTING';

  return (
    <div className="h-dvh sm:p-6">
      <div className="console relative isolate mx-auto grid h-full max-w-[720px] grid-rows-[auto_1fr_auto_auto] overflow-hidden sm:rounded-2xl sm:border sm:border-white/8 sm:shadow-[0_0_90px_-10px_rgb(70_70_160/0.35)]">
        <div className="glow pointer-events-none absolute inset-x-0 top-0 -z-10 h-[60%]" aria-hidden="true" />

        <header className="flex items-center gap-3.5 border-b border-border px-5 pt-[calc(1rem+env(safe-area-inset-top))] pb-4">
          <Avatar name={name || '·'} speaking={Boolean(playing)} className="size-12 text-xl" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[44px] leading-[0.9] text-foreground sm:text-[52px]">{name ? <DotName name={name} /> : ' '}</h1>
            <p className="label-mono mt-2 flex items-center gap-2 text-muted-foreground">
              <motion.span className={cn('size-1.5 rounded-full', online ? 'bg-primary' : 'bg-muted-foreground')}
                animate={thinking ? { opacity: [1, 0.25, 1] } : { opacity: 1 }}
                transition={thinking ? { duration: 1.1, repeat: Infinity } : { duration: 0.2 }} />
              <AnimatePresence mode="wait" initial={false}>
                <motion.span key={onAir} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.18 }}
                  className={cn(playing && 'text-primary')}>
                  {onAir}
                </motion.span>
              </AnimatePresence>
            </p>
          </div>
          <Button variant="outline" onClick={() => setSettingsOpen(true)} aria-label="设置"
            className="label-mono relative h-9 rounded-full border-white/15 bg-transparent px-3.5 text-subtle hover:bg-white/5 dark:bg-transparent">
            <Settings className="size-3.5" />
            {needsSetup && <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-destructive" />}
          </Button>
        </header>

        <MessageList messages={chat.messages} status={chat.status} name={name} />

        <Composer status={chat.status} disabled={!online || !status?.brain.ready}
          onSend={chat.send} onInterrupt={chat.interrupt} />

        <footer className="label-mono flex items-center justify-between px-5 pt-1 pb-[calc(0.625rem+env(safe-area-inset-bottom))] text-[10px] text-muted-foreground/70">
          <span>Find my voice</span>
          <span className="flex items-center gap-1.5">
          </span>
        </footer>

        {status && (
          <SettingsPanel open={settingsOpen} status={status} onOpenChange={setSettingsOpen}
            onSaved={() => { void refresh(); setSettingsOpen(false); }} />
        )}
        <Toaster position="top-center" />
      </div>
    </div>
  );
}
