import { useCallback, useEffect, useState } from 'react';
import { Settings } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { api, type AppStatus } from '@/api';
import { audio } from '@/audio';
import { Composer } from '@/components/Composer';
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

  const thinking = chat.status === 'thinking';
  const name = status?.companionName ?? '…';
  const mood = playing ? '正在对你说' : thinking ? '在想怎么回你' : chat.connection === 'open' ? '在' : '连接中…';
  const needsSetup = status !== null && (!status.brain.ready || !status.voice.ready);

  return (
    <div className="relative isolate grid h-dvh grid-rows-[auto_1fr_auto]">
      <div className="sky fixed inset-0 -z-10 overflow-hidden" aria-hidden="true">
        <motion.div className="halo absolute top-[-30vmax] left-1/2 size-[90vmax] -translate-x-1/2 rounded-full blur-[20px]"
          animate={thinking && !playing ? { opacity: [1, 0.6, 1] } : { opacity: 1 }}
          transition={thinking && !playing ? { duration: 3.2, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.6 }} />
        <div className="grain pointer-events-none absolute -inset-1/2 opacity-[0.07] mix-blend-overlay" />
      </div>

      <header className="mx-auto grid w-full max-w-[680px] grid-cols-[auto_1fr_auto] items-center gap-3.5 px-4 pt-[calc(0.875rem+env(safe-area-inset-top))] pb-2.5">
        <div className="grid size-11 place-items-center" aria-hidden="true">
          <motion.span className="orb size-5.5 rounded-full"
            animate={thinking && !playing ? { scale: [1, 0.82, 1], opacity: [1, 0.7, 1] } : {}}
            transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }} />
        </div>
        <div>
          <h1 className="font-heading text-[26px] leading-tight font-medium tracking-wide text-mist [font-variation-settings:'opsz'_72,'SOFT'_100]">{name}</h1>
          <AnimatePresence mode="wait" initial={false}>
            <motion.p key={mood} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.2 }}
              className={cn('mt-0.5 min-h-[1.6em] text-[13px]', playing ? 'text-primary' : 'text-muted-foreground/70')}>
              {mood}
            </motion.p>
          </AnimatePresence>
        </div>
        <Button variant="ghost" size="icon-lg" className="relative rounded-full text-muted-foreground" onClick={() => setSettingsOpen(true)} aria-label="设置">
          <Settings className="size-4.5" />
          {needsSetup && <span className="absolute top-1.5 right-1.5 size-1.75 rounded-full bg-destructive" />}
        </Button>
      </header>

      <MessageList messages={chat.messages} status={chat.status} name={name} />

      <Composer status={chat.status} disabled={chat.connection !== 'open' || !status?.brain.ready}
        onSend={chat.send} onInterrupt={chat.interrupt} />

      {status && (
        <SettingsPanel open={settingsOpen} status={status} onOpenChange={setSettingsOpen}
          onSaved={() => { void refresh(); setSettingsOpen(false); }} />
      )}
      <Toaster position="top-center" />
    </div>
  );
}
