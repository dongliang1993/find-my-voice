import { useEffect, useLayoutEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { ChatMessage, CompanionStatus } from '@shared/protocol';
import { VoiceBubble } from '@/components/VoiceBubble';
import { cn } from '@/lib/utils';

const GAP_MS = 10 * 60 * 1000;
const EASE_OUT = [0.22, 1, 0.36, 1] as const;

const timeLabel = (iso: string) => {
  const date = new Date(iso);
  const today = new Date().toDateString() === date.toDateString();
  return date.toLocaleString('zh-CN', today ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
      <div className="mx-auto flex min-h-full w-full max-w-[680px] flex-col justify-end px-4 pt-3 pb-6">
        {!messages.length && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: EASE_OUT }}
            className="my-auto px-2 pb-[18vh] text-center">
            <p className="font-heading text-3xl italic text-mist">今晚想聊点什么？</p>
            <p className="mt-2.5 text-muted-foreground">打字给{name}，她会回你。想听她的声音，就直接说。</p>
          </motion.div>
        )}

        {messages.map((message, i) => {
          const prev = messages[i - 1];
          const showTime = !prev || Date.parse(message.createdAt) - Date.parse(prev.createdAt) > GAP_MS;
          const grouped = prev?.role === message.role && !showTime;
          const user = message.role === 'user';
          return (
            <div key={message.id}>
              {showTime && (
                <time dateTime={message.createdAt} className="mt-5.5 mb-2.5 block text-center text-xs tracking-widest text-muted-foreground/70">
                  {timeLabel(message.createdAt)}
                </time>
              )}
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.32, ease: EASE_OUT }}
                className={cn('flex', grouped ? 'mt-1' : 'mt-3.5', user && 'justify-end')}>
                {message.kind === 'voice' ? <VoiceBubble message={message} /> : (
                  <p className={cn(
                    'max-w-[min(78%,520px)] rounded-[20px] px-3.75 py-2.5 wrap-anywhere whitespace-pre-wrap',
                    user
                      ? cn('rounded-br-md bg-mist text-mist-foreground', grouped && 'rounded-tr-md')
                      : cn('rounded-bl-md bg-card shadow-[inset_0_1px_0_oklch(0.95_0.03_290/0.06)]', grouped && 'rounded-tl-md'),
                  )}>
                    {message.text || ' '}
                  </p>
                )}
              </motion.div>
            </div>
          );
        })}

        <AnimatePresence>
          {showTyping && (
            <motion.div key="typing" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.15 } }}
              className="mt-3.5 flex">
              <p className="inline-flex gap-1.5 rounded-[20px] rounded-bl-md bg-card px-4 py-4" aria-label={`${name}正在输入`}>
                {[0, 1, 2].map(i => (
                  <motion.i key={i} className="size-1.5 rounded-full bg-muted-foreground"
                    animate={{ y: [0, -4, 0], opacity: [0.4, 1, 0.4] }}
                    transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.15, ease: 'easeInOut' }} />
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
