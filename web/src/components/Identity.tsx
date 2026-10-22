import { cn } from '@/lib/utils';

const LATIN = /^[\x20-\x7e]+$/;

/** Her name as a dot-matrix wordmark. Doto has no CJK glyphs, so those get a dot mask instead. */
export function DotName({ name, className }: { name: string; className?: string }) {
  return <span className={cn(LATIN.test(name) ? 'dot-name' : 'dot-mask', className)}>{name}</span>;
}

/** Her avatar: initial on indigo. The mint ring lights up and breathes while she speaks. */
export function Avatar({ name, speaking, className }: { name: string; speaking?: boolean; className?: string }) {
  return (
    <span aria-hidden="true"
      className={cn(
        'grid flex-none place-items-center rounded-full bg-[radial-gradient(circle_at_35%_30%,#4a4e86,#16172e)] font-mono font-bold text-white/90 ring-1 ring-white/15 transition-shadow duration-300',
        speaking && 'voice-ring',
        className,
      )}>
      {([...name][0] ?? '·').toUpperCase()}
    </span>
  );
}
