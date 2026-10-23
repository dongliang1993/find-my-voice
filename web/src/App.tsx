import { Fragment, useEffect, useState } from 'react';
import { RadioTower, Settings, Sunset } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { audio } from '@/lib/audio';
import { Composer } from '@/components/Composer';
import { Avatar, DotName } from '@/components/Identity';
import { MessageList } from '@/components/MessageList';
import { Onboarding } from '@/features/onboarding/Onboarding';
import { SettingsPanel } from '@/components/SettingsPanel';
import { Spiral } from '@/components/Spiral';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { LoadingGate } from '@/features/loading';
import { useChat } from '@/hooks/useChat';
import { useReachOut } from '@/hooks/useReachOut';
import { usePlaying, useVoiceGlow } from '@/hooks/useVoice';
import { setTheme, useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { useGlobal } from '@/store/global';

export function App() {
  const chat = useChat();
  const playing = usePlaying();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const ready = useGlobal(store => store.ready);
  const status = useGlobal(store => store.status);
  const onboarding = useGlobal(store => store.onboarding);
  const { theme } = useTheme();
  const her = theme === 'her';
  useVoiceGlow();

  useReachOut(chat.reached, chat.messages, status?.companionName ?? '');

  // First things first: until the first fetch lands there is no console to show.
  const checkReady = useGlobal(store => store.checkReady);
  const refreshStatus = useGlobal(store => store.refreshStatus);
  const markOnboarded = useGlobal(store => store.markOnboarded);
  useEffect(() => {
    checkReady();
  }, [checkReady]);
  // First visit without a model: open setup straight away.
  useEffect(() => { if (status && !status.brain.ready) setSettingsOpen(true); }, [status]);
  // Any gesture unlocks audio so her first voice message can autoplay.
  useEffect(() => {
    const unlock = () => audio.unlock();

    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });

    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    }
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
  /** Undecided until the first fetch lands; never true once it is over. */
  const firstMeeting = onboarding !== null && onboarding.completedAt === null;

  // The first meeting runs before anything else; a finished one never returns.
  // The opening plays by itself, so it must know whether a voice is ready before it starts.
  const screen = firstMeeting
    ? status && <Onboarding voiceReady={status.voice.ready} listenReady={status.listen.ready} onDone={() => {
      markOnboarded();
      refreshStatus();
    }} />
    : (
      <div className="h-dvh sm:p-6">
        <div className="console relative isolate mx-auto grid h-full max-w-[720px] grid-rows-[auto_1fr_auto_auto] overflow-hidden sm:rounded-2xl sm:border sm:border-hairline sm:shadow-(--panel-shadow)">
          <div className="glow pointer-events-none absolute inset-x-0 top-0 -z-10 h-[60%]" aria-hidden="true" />
          <div className="grain pointer-events-none absolute inset-0 z-50" aria-hidden="true" />

          <header className="flex items-center gap-3.5 border-b border-border px-5 pt-[calc(1rem+env(safe-area-inset-top))] pb-4">
            {her
              ? (
                // Same layoutId as the onboarding coil: at the end of the first meeting she flies up here.
                <motion.div layoutId="her-spiral" className="-my-2 -ml-2 size-16 flex-none">
                  <Spiral thinking={thinking} className="size-full" />
                </motion.div>
              )
              : <Avatar name={name || '·'} speaking={Boolean(playing)} className="size-12 text-xl" />}
            <div className="min-w-0 flex-1">
              <h1 className={cn('truncate leading-[0.9] text-foreground', her ? 'pb-1 text-[38px] sm:text-[44px]' : 'text-[44px] sm:text-[52px]')}>{name ? <DotName name={name} /> : ' '}</h1>
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
            <Button variant="outline" onClick={() => setTheme(her ? 'radio' : 'her')} aria-label={her ? '换成深夜电台' : '换成 Her'}
              title={her ? '深夜电台' : 'Her'}
              className="h-9 rounded-full border-edge bg-transparent px-3 text-subtle hover:bg-wash dark:bg-transparent">
              {her ? <RadioTower className="size-3.5" /> : <Sunset className="size-3.5" />}
            </Button>
            <Button variant="outline" onClick={() => setSettingsOpen(true)} aria-label="设置"
              className="label-mono relative h-9 rounded-full border-edge bg-transparent px-3.5 text-subtle hover:bg-wash dark:bg-transparent">
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
              onSaved={() => { void refreshStatus(); setSettingsOpen(false); }} />
          )}
          <Toaster position="top-center" />
        </div>
      </div>
    );

  // The gate covers the viewport while it exits, so the console mounts underneath
  // and is simply revealed by the fade.
  return (
    <AnimatePresence>
      {ready ? <Fragment key="screen">{screen}</Fragment> : <LoadingGate key="gate" />}
    </AnimatePresence>
  );
}
