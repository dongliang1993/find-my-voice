import { Fragment, useEffect, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import { audio } from '@/lib/audio';
import { Onboarding } from '@/features/onboarding/Onboarding';
import { Toaster } from '@/components/ui/sonner';
import { LoadingGate } from '@/features/loading';
import { startBoot, useBoot } from '@/features/loading/boot';
import { Stage } from '@/features/stage/Stage';
import { useDemo } from '@/features/demo/useDemo';
import { useChat } from '@/hooks/useChat';
import { useReachOut } from '@/hooks/useReachOut';
import { usePlaying, useVoiceGlow } from '@/hooks/useVoice';
import { useGlobal } from '@/store/global';

const isShell = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function App() {
  const chat = useChat();
  const playing = usePlaying();
  /** The first meeting just ended on this page: the stage takes over from its last frame. */
  const [arrived, setArrived] = useState(false);
  const entered = useBoot(store => store.entered);
  const status = useGlobal(store => store.status);
  const onboarding = useGlobal(store => store.onboarding);
  useVoiceGlow();

  useReachOut(chat.reached, chat.messages, status?.companionName ?? '');

  // First things first: until the first fetch lands there is no console to show.
  const refreshStatus = useGlobal(store => store.refreshStatus);
  const markOnboarded = useGlobal(store => store.markOnboarded);
  useEffect(() => { startBoot(); }, []);
  // She changed a setting because she was asked to; the app's own language may have gone with it.
  useEffect(() => { if (chat.settingsStamp) void refreshStatus(); }, [chat.settingsStamp, refreshStatus]);
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
  const name = status?.companionName ?? '';
  const needsSetup = status !== null && (!status.brain.ready || !status.voice.ready);
  /** Undecided until the first fetch lands; never true once it is over. */
  const firstMeeting = onboarding !== null && onboarding.completedAt === null;
  useDemo(chat.demo, chat.cue, chat.demoAction, { meeting: firstMeeting });

  // The first meeting runs before anything else; a finished one never returns.
  // The opening plays by itself, so it must know whether a voice is ready before it starts.
  const screen = firstMeeting
    ? status && <Onboarding initial={onboarding} demo={chat.demo?.meeting ?? null} voiceReady={status.voice.ready} listenReady={status.listen.ready} onDone={() => {
      setArrived(true);
      markOnboarded();
      refreshStatus();
    }} />
    : status && (
      <>
        <Stage messages={chat.messages} status={chat.status} name={name} playing={playing}
          lines={chat.lines} canListen={Boolean(status.listen.ready)} arrived={arrived}
          papers={chat.papers} stage={chat.stage} edits={chat.edits} saved={chat.saved}
          appStatus={status} settingsStamp={chat.settingsStamp}
          onSend={chat.send} onInterrupt={chat.interrupt}
          needsSetup={needsSetup}
          online={online && Boolean(status.brain.ready)}
          resting={chat.resting} onWake={chat.wake}
          onReading={chat.setReading}
          demo={chat.demo && { clock: chat.demo.clock, cue: chat.cue }} />
        <Toaster position="top-center" />
      </>
    );

  // The gate covers the viewport while it exits, so the console mounts underneath
  // and is simply revealed by the fade.
  return (
    <>
      <AnimatePresence>
        {entered ? <Fragment key="screen">{screen}</Fragment> : <LoadingGate key="gate" />}
      </AnimatePresence>
      {/* With the title bar gone, this strip is what the window is dragged by. */}
      {isShell && <div data-tauri-drag-region className="fixed inset-x-0 top-0 z-[300] h-(--titlebar)" />}
    </>
  );
}
