import { useRef, useState, type KeyboardEvent, type SubmitEvent } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { CompanionStatus } from '@shared/protocol';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

type Props = { status: CompanionStatus; disabled: boolean; onSend: (text: string) => void; onInterrupt: () => void };

const pop = { initial: { scale: 0.6, opacity: 0 }, animate: { scale: 1, opacity: 1 }, exit: { scale: 0.6, opacity: 0 }, transition: { duration: 0.18 } };

export function Composer({ status, disabled, onSend, onInterrupt }: Props) {
  const [text, setText] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const busy = status !== 'idle';

  // Sending while she replies is fine: the server queues it, like double-texting.
  const submit = (event?: SubmitEvent<HTMLFormElement> | KeyboardEvent<HTMLTextAreaElement>) => {
    event?.preventDefault();
    const value = text.trim();
    if (!value || disabled) return;
    onSend(value);
    setText('');
    input.current?.focus();
  };

  // Enter sends; Shift+Enter breaks the line; never send mid IME composition.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
  };

  return (
    <form onSubmit={submit} className="flex items-end gap-2.5 border-t border-border bg-black/60 px-5 pt-3.5 pb-3.5">
      <label className="sr-only" htmlFor="composer-input">消息</label>
      <Textarea id="composer-input" ref={input} rows={1} value={text} placeholder="说点什么…" maxLength={4000}
        onChange={e => setText(e.target.value)} onKeyDown={onKeyDown} enterKeyHint="send" autoFocus
        className="max-h-40 min-h-12 resize-none rounded-md border-white/25 bg-black px-4 py-3 font-mono text-[15px] leading-normal placeholder:text-muted-foreground/70 focus-visible:border-primary/60 focus-visible:ring-primary/15 md:text-[15px] dark:bg-black" />
      <AnimatePresence mode="popLayout" initial={false}>
        {busy && !text.trim() ? (
          <motion.div key="stop" {...pop}>
            <Button type="button" variant="outline" size="icon" onClick={onInterrupt} aria-label="让她先停下"
              className="size-12 rounded-full border-primary/40 bg-black text-primary hover:bg-primary/10 dark:bg-black">
              <Square className="size-3.5 fill-current" />
            </Button>
          </motion.div>
        ) : (
          <motion.div key="send" {...pop} whileTap={{ scale: 0.92 }}>
            <Button type="submit" size="icon" disabled={!text.trim() || disabled} aria-label="发送"
              className="size-12 rounded-full shadow-[0_0_24px_-6px_var(--mint-glow)] disabled:bg-white/15 disabled:text-white/60 disabled:opacity-100 disabled:shadow-none">
              <ArrowUp className="size-5" strokeWidth={2.2} />
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </form>
  );
}
