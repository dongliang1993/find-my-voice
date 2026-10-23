import { useEffect, useLayoutEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { ChatMessage, CompanionStatus, InitiativeKind } from '@shared/protocol';
import { Avatar } from '@/components/Identity';
import { VoiceBubble } from '@/components/VoiceBubble';
import { cn } from '@/lib/utils';

const GAP_MS = 10 * 60 * 1000;
const EASE_OUT = [0.22, 1, 0.36, 1] as const;
/** Shown next to her name when she spoke first. */
const INITIATIVE_LABEL: Record<InitiativeKind, string> = { followup: 'Remembered', morning: 'Morning', miss_you: 'Missed you' };

/** The empty screen speaks to the hour, not always to the night. */
const greeting = () => {
  const hour = new Date().getHours();
  return hour < 5 ? '这么晚还没睡？' : hour < 11 ? '早上好，今天想聊点什么？' : hour < 18 ? '下午好，想聊点什么？' : '今晚想聊点什么？';
};

const clock = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
const dayLabel = (iso: string) => {
  const date = new Date(iso);
  if (new Date().toDateString() === date.toDateString()) return clock(iso);
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
};

type Props = { messages: ChatMessage[]; status: CompanionStatus; name: string };

export function MessageList({ messages, status, name }: Props) {
  const end = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);

  // Follow new content only while the reader is already at the bottom.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => { stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useLayoutEffect(() => {
    if (stuck.current) end.current?.scrollIntoView({ block: 'end' });
  }, [messages, status]);

  const last = messages.at(-1);
  const showTyping = status === 'thinking' && !(last?.role === 'assistant' && last.kind === 'text' && last.text);

  return (
    <div ref={scroller} role="log" aria-live="polite" aria-label={`和${name}的对话`}
      className="overflow-y-auto overscroll-contain [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin]">
      <div className="flex min-h-full flex-col justify-end px-5 pt-4 pb-6">
        {!messages.length && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: EASE_OUT }}
            className="my-auto pb-[14vh] text-center">
            <p className="label-mono text-muted-foreground/70">— Channel open —</p>
            <p className="mt-4 font-heading text-2xl font-medium text-foreground">{greeting()}</p>
            <p className="mt-2 text-sm text-muted-foreground">打字给{name || 'Ta'}，Ta 会回你。想听 Ta 的声音，就直接说。</p>
          </motion.div>
        )}

        {messages.map((message, i) => {
          const prev = messages[i - 1];
          const newBlock = !prev || Date.parse(message.createdAt) - Date.parse(prev.createdAt) > GAP_MS;
          const grouped = prev?.role === message.role && !newBlock;
          const user = message.role === 'user';
          const next = messages[i + 1];
          // One timestamp per turn: under her last bubble before the reply changes hands.
          const endsTurn = !user && message.kind === 'text' && Boolean(message.text) && next?.role !== 'assistant';
          return (
            <div key={message.id}>
              {newBlock && (
                <p className="label-mono my-5 text-center text-muted-foreground/60">
                  <time dateTime={message.createdAt}>{dayLabel(message.createdAt)}</time>
                </p>
              )}
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.32, ease: EASE_OUT }}
                className={cn('flex gap-3', grouped ? 'mt-1.5' : 'mt-5', user && 'flex-row-reverse')}>
                {!user && (grouped ? <span className="w-9 flex-none" /> : <Avatar data-slot="头像" name={name || '·'} className="mt-1.5 size-9 text-[20px]" />)}
                <div className={cn('flex min-w-0 max-w-[min(82%,540px)] flex-col', user && 'items-end')}>
                  {!grouped && (
                    <p className="label-mono mb-2 flex items-center gap-2 text-muted-foreground">
                      {user ? 'You' : name}
                      {message.initiative && (
                        <span className="flex items-center gap-1 text-[10px] text-primary/80">
                          <span className="size-1 rounded-full bg-primary" />{INITIATIVE_LABEL[message.initiative]}
                        </span>
                      )}
                    </p>
                  )}
                  {message.kind === 'voice' ? <VoiceBubble message={message} /> : (
                    <p className={cn(
                      'wrap-anywhere whitespace-pre-wrap',
                      user
                        ? 'rounded-md border border-hairline bg-secondary/70 px-3 py-2 text-[14px] leading-snug text-foreground'
                        : 'letter text-foreground',
                    )}>
                      {message.text || ' '}
                    </p>
                  )}
                  {endsTurn && (
                    <p className="label-mono mt-2 text-[10px] text-muted-foreground/60">{clock(message.createdAt)}</p>
                  )}
                </div>
              </motion.div>
            </div>
          );
        })}

        <AnimatePresence>
          {showTyping && (
            <motion.div key="typing" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.15 } }}
              className="mt-5 flex gap-3">
              <Avatar name={name || '·'} className="size-9 text-[20px]" />
              <p className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-4 py-3.5" aria-label={`${name}正在输入`}>
                {[0, 1, 2].map(i => (
                  <motion.i key={i} className="size-1.5 rounded-full bg-primary"
                    animate={{ opacity: [0.2, 1, 0.2] }}
                    transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.18, ease: 'easeInOut' }} />
                ))}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
        <div ref={end} />
      </div>
    </div>
  );
}
