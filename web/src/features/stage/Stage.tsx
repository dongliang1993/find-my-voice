import { useCallback, useEffect, useRef, useState } from 'react';
import { History, Keyboard, Mic, Settings, Square } from 'lucide-react';
import type { ChatMessage, CompanionStatus } from '@shared/protocol';
import { MessageList } from '@/components/MessageList';
import { Spiral } from '@/components/Spiral';
import { api } from '@/lib/api';
import { microphone } from '@/lib/microphone';
import { cn } from '@/lib/utils';
import { useIdleChrome } from '@/hooks/useIdleChrome';
import { useAmbientTheme, type Mood } from '@/features/stage/ambient';
import { stageState, VISUALS } from '@/features/stage/state';

/** Her most recent line, if the turn is still being played out. */
function latestLine(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'assistant' && m.text) return m.text;
    if (m.role === 'user') return '';
  }
  return '';
}

/** Her emotion, mapped onto the four moods the light knows. */
const moodOf = (emotion: string | null | undefined): Mood =>
  emotion === 'happy' ? 'happy' : emotion === 'low' || emotion === 'sad' ? 'low'
    : emotion === 'longing' ? 'longing' : 'calm';

type Props = {
  messages: ChatMessage[];
  status: CompanionStatus;
  name: string;
  playing: boolean;
  listening: boolean;
  onSend: (text: string) => void;
  onInterrupt: () => void;
  onOpenSettings: () => void;
  needsSetup: boolean;
  online: boolean;
  onListenChange: (listening: boolean) => void;
};

/**
 * The main screen, after the film: one coral stage in a cream room, and both
 * of you on it. Your words arrive as subtitles, hers as the large line under
 * the wave; the microphone sits on the stage with you rather than under it.
 * The thread is behind the history button — the stage itself stays uncluttered.
 *
 * The light follows the hour and her mood, the chrome steps back when you stop
 * moving, and everything that changes does so slowly, so nothing snaps.
 */
export function Stage({
  messages, status, name, playing, listening, onSend, onInterrupt,
  onOpenSettings, needsSetup, online, onListenChange,
}: Props) {
  const room = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');
  const [typing, setTyping] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [lastSaid, setLastSaid] = useState('');

  const state = stageState({ status, playing, listening });
  const visual = VISUALS[state];
  useAmbientTheme(room, moodOf(messages.at(-1)?.emotion));
  // The buttons step back while nothing is happening; they stay put while you speak.
  const hidden = useIdleChrome(3000, listening);

  // The coil reads her own loudness through the shared engine; the microphone
  // only needs to be open, which `listening` already says.


  /* ---- One spoken turn: record, transcribe, send, all on the same path ---- */
  const recorder = useRef<MediaRecorder | null>(null);

  const startListening = useCallback(async () => {
    if (state === 'speaking') onInterrupt();
    if (!microphone.supported || recorder.current) return;
    const opened = await microphone.open().then(() => true, () => false);
    const stream = microphone.stream;
    if (!opened || !stream) return;
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported(t)) ?? '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    rec.onstop = () => {
      recorder.current = null;
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      if (!blob.size) return;
      // The server only turns it into words; sending stays on the socket path.
      void api.hear(blob, (rec.mimeType || 'audio/webm').split(';')[0]!)
        .then(({ text }) => { if (text.trim()) onSend(text.trim()); })
        .catch(() => {});
    };
    rec.start();
    recorder.current = rec;
    setLastSaid('');
    onListenChange(true);
  }, [state, onInterrupt, onListenChange, onSend]);

  const stopListening = useCallback(() => {
    if (recorder.current?.state === 'recording') recorder.current.stop();
    onListenChange(false);
    microphone.close();
  }, [onListenChange]);

  // Space is the microphone, unless the caret is in a field.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat || (event.target as HTMLElement | null)?.closest('input, textarea')) return;
      event.preventDefault();
      void startListening();
    };
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') { event.preventDefault(); stopListening(); } };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [startListening, stopListening]);

  const send = () => {
    const text = draft.trim();
    if (!text || !online) return;
    onSend(text);
    setLastSaid(text);
    setDraft('');
  };

  const line = latestLine(messages);
  const caption = listening ? '' : lastSaid;

  return (
    <div ref={room}
      className="relative isolate flex h-dvh items-stretch justify-center overflow-hidden bg-(--base) text-(--ink) transition-colors duration-[2500ms] sm:items-center sm:p-8">
      {/* The first meeting's card, exactly: a coral panel over a cream mat, both
          measured by the same variables, so moving between the two never resizes. */}
      <main className="relative flex h-full w-full max-w-[880px] flex-col overflow-hidden bg-(--her) text-white transition-[background-color,filter] duration-[2500ms] sm:h-auto sm:rounded-[3px] sm:shadow-(--panel-shadow) sm:ring-1 sm:ring-hairline"
        style={{ filter: `brightness(${visual.herBrightness})` }}>
        {/* Laid over the panel, not in the flow: the card's height is the panel
            plus the mat, exactly as in the first meeting. */}
        <header className={cn('absolute inset-x-0 top-0 z-20 flex items-center justify-between px-6 pt-[calc(1rem+env(safe-area-inset-top))] pb-2 transition-opacity duration-500', hidden && 'pointer-events-none opacity-0')}>
          <span className="font-heading text-[20px] italic opacity-85">{name}</span>
          <div className="flex gap-2.5">
            <button type="button" onClick={() => setHistoryOpen(open => !open)} aria-label="历史" aria-pressed={historyOpen}
              className="grid size-9 place-items-center rounded-full ring-1 ring-white/40 transition-colors hover:bg-white/10">
              <History className="size-4" />
            </button>
            <button type="button" onClick={onOpenSettings} aria-label="设置"
              className="relative grid size-9 place-items-center rounded-full ring-1 ring-white/40 transition-colors hover:bg-white/10">
              <Settings className="size-4" />
              {needsSetup && <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-white" />}
            </button>
          </div>
        </header>

        {/* Her half: the panel, at the panel's own height. Her coil sits on a
            fixed line rather than being centred with her words — otherwise every
            extra line of text pushes it up, and it never rests in one place. */}
        <section className="flex h-[58dvh] flex-none flex-col items-center overflow-hidden px-8 pt-[18%] text-center transition-colors duration-[2500ms] sm:h-(--os1-panel-h) sm:pt-[92px]">
          <p aria-live="polite"
            className={cn('mb-4 min-h-[1.6em] max-w-[34em] text-[15px] leading-relaxed transition-opacity duration-500',
              listening || caption ? 'text-white/75' : 'text-white/0')}>
            {listening ? '在听你说…' : caption}
          </p>
          {/* Her coil, the same one the first meeting draws: it is her presence,
              not a level meter, so it stays even when the room is silent. */}
          <div className="size-40 flex-none text-white [--spiral:#fff] sm:size-52">
            <Spiral thinking={state === 'thinking'} stage="awake" listening={state === 'listening'}
              rest={0.12} weight={1 / 70} className="size-full" />
          </div>
          <p aria-live="polite"
            className="mt-7 max-w-[22em] font-heading text-[19px] leading-[1.6] transition-[filter,opacity] duration-[600ms] sm:text-[21px]"
            style={{ filter: `blur(${visual.lineBlur}px)`, opacity: visual.lineOpacity }}>
            {line}
          </p>
        </section>

        {/* Your half: the mat, at the mat's own height. */}
        <footer className="flex flex-1 flex-col items-center justify-center gap-3.5 px-6 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:h-(--os1-mat-h) sm:flex-none sm:pb-4">
          {typing && (
            <form className="w-[min(520px,86%)]" onSubmit={event => { event.preventDefault(); send(); }}>
              <input autoFocus value={draft} maxLength={4000} placeholder="说点什么…" aria-label="消息"
                onChange={event => setDraft(event.target.value)}
                onKeyDown={event => { if (event.key === 'Escape') setTyping(false); }}
                className="w-full rounded-full border border-white/35 bg-white/12 px-5 py-3 text-[15px] text-white outline-none transition-colors placeholder:text-white/55 focus:border-white/60" />
            </form>
          )}

          <div className="flex items-center gap-6">
            <button type="button" onClick={() => setTyping(t => !t)} aria-label={typing ? '用语音' : '打字'} aria-pressed={typing}
              className="grid size-[38px] place-items-center rounded-full ring-1 ring-white/30 transition-colors hover:bg-white/10">
              {typing ? <Mic className="size-4" /> : <Keyboard className="size-4" />}
            </button>

            <button type="button" onClick={() => (listening ? stopListening() : void startListening())}
              data-look={visual.mic} aria-label={listening ? '结束说话' : '开始说话'} aria-pressed={listening}
              className={cn('relative grid size-[62px] place-items-center rounded-full border-[1.5px] border-white/90 transition-[opacity,transform,background-color] duration-500',
                'before:absolute before:-inset-2.5 before:rounded-full before:bg-white before:opacity-0 before:transition-opacity',
                listening && 'bg-white/15 before:opacity-15',
                visual.mic === 'dim' && 'scale-92 opacity-45')}>
              {listening ? <Square className="size-4 fill-current" /> : <Mic className="size-5" />}
            </button>

            <span className="size-[38px]" aria-hidden="true" />
          </div>

          <span className={cn('text-[12px] opacity-55 transition-opacity duration-500', hidden && !listening && 'opacity-0')}>
            {listening ? '说完点一下结束' : '按住空格说话'}
          </span>
        </footer>

        {/* Film: grain over everything, and a vignette that closes the corners.
            Both are inert; the grain is a static tile, so it costs one paint. */}
        <div className="grain grain-live pointer-events-none absolute z-5 [--grain-opacity:0.16]" aria-hidden="true" />
        <div className="pointer-events-none absolute inset-0 z-5 bg-[radial-gradient(ellipse_at_center,transparent_55%,rgb(60_20_10/0.22))]" aria-hidden="true" />
      </main>

      {/* The thread slides in from the right edge of the stage, on the same mat the card sits on. */}
      <div className={cn('absolute inset-x-4 bottom-4 z-20 max-h-[62dvh] overflow-hidden rounded-[6px] bg-card text-foreground shadow-(--panel-shadow) ring-1 ring-hairline transition-[opacity,transform] duration-500 sm:inset-x-auto sm:right-[calc(2rem+1px)] sm:bottom-[calc(2rem+1px)] sm:w-[380px]',
        historyOpen ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0')}>
        <div className="flex h-[54dvh] flex-col sm:h-[46dvh]">
          <div className="min-h-0 flex-1">
            <MessageList messages={messages} status={status} name={name} />
          </div>
        </div>
      </div>
    </div>
  );
}
