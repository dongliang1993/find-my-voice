import { forwardRef, type ComponentProps, type ReactNode } from 'react';
import { ArrowUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/*
 * The answer mat's parts. The coral above is hers; everything the user does
 * lives here: their own voice, and the one field that a spoken or a typed
 * answer both land in.
 */

/**
 * A field on the mat: one hairline, warm brown, no glow and no resize handle —
 * it should read as a line you write on, not as a form control.
 */
const FIELD = 'border-(--field-edge)/60 bg-(--field) text-foreground placeholder:text-muted-foreground/70 hover:border-(--field-edge) focus-visible:border-(--field-edge) focus-visible:ring-0 dark:bg-(--field)';

export const AnswerInput = forwardRef<HTMLInputElement, ComponentProps<typeof Input>>(({ className, ...props }, ref) => (
  <Input ref={ref} className={cn('h-11 rounded-full px-5 text-base md:text-base', FIELD, className)} {...props} />
));

/** Grows with what is typed, up to a few lines, then scrolls. */
export const AnswerText = forwardRef<HTMLTextAreaElement, ComponentProps<typeof Textarea>>(({ className, ...props }, ref) => (
  <Textarea ref={ref} rows={1}
    className={cn('field-sizing-content max-h-28 min-h-11 resize-none rounded-[1.375rem] px-5 py-3 text-base leading-normal md:text-base', FIELD, className)}
    {...props} />
));

/**
 * The way forward. Solid red once there is something to send — the deep
 * primary, not the panel coral, so its label passes AA — and a quiet outline
 * until then, never the washed-out look of a broken control.
 */
export function Submit({ ready, children, className, ...props }: ComponentProps<typeof Button> & { ready: boolean }) {
  return (
    <Button type="submit" disabled={!ready} {...props}
      className={cn('h-10 rounded-full px-6 text-[15px] transition-colors',
        ready ? 'bg-primary text-primary-foreground hover:bg-primary/90'
          : 'border border-(--field-edge)/50 bg-transparent text-muted-foreground disabled:opacity-100',
        className)}>
      {children}
    </Button>
  );
}

/** A secondary choice on the mat: plain text, no box. */
export function Quiet({ className, ...props }: ComponentProps<typeof Button>) {
  return <Button type="button" variant="ghost" className={cn('h-8 rounded-full px-3 text-[13px] text-muted-foreground hover:text-foreground', className)} {...props} />;
}

/**
 * The way past a question: a line of text, not a button. Nothing here should
 * compete with the microphone for the eye.
 */
export function Skip({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <button type="button" {...(props as object)}
      className={cn('text-[13px] text-muted-foreground/80 underline-offset-4 transition-colors hover:text-foreground hover:underline', className)}>
      {props.children}
    </button>
  );
}

/**
 * The field with its send button inside on the right, so the one row that
 * carries a spoken or a typed answer holds the way out too. The arrow only
 * turns red once there is something to send.
 */
export function AnswerField({ value, ready, placeholder, label, onChange, autoFocus, inputRef }: {
  value: string; ready: boolean; placeholder: string; label: string;
  onChange: (value: string) => void; autoFocus?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <div className="relative w-full">
      <AnswerInput ref={inputRef} value={value} maxLength={40} aria-label={label} placeholder={placeholder} autoFocus={autoFocus}
        onChange={event => onChange(event.target.value)} className="h-11 pr-12" />
      <button type="submit" disabled={!ready} aria-label="Send"
        className={cn('absolute top-1/2 right-1 grid size-8 -translate-y-1/2 place-items-center rounded-full transition-colors',
          ready ? 'text-primary hover:bg-primary/10' : 'text-muted-foreground/45 disabled:opacity-100')}>
        <ArrowUp className="size-4" strokeWidth={2.4} />
      </button>
    </div>
  );
}

/** One answer: whatever the step shows, stacked and centred. */
export function Answer({ children, onSubmit }: { children: ReactNode; onSubmit: () => void }) {
  return (
    <form className="grid w-full justify-items-center gap-3"
      onSubmit={event => {
        event.preventDefault();
        onSubmit();
      }}>
      {children}
    </form>
  );
}
