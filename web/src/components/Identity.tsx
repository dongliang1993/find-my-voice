import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

const LATIN = /^[\x20-\x7e]+$/;

/**
 * Her name as a wordmark. Radio prints it dot-matrix (Doto has no CJK glyphs,
 * so those get a dot mask instead); Her writes it in a soft italic serif.
 */
export function DotName({ name, className }: { name: string; className?: string }) {
  const { theme } = useTheme();
  const style = theme === 'her' ? 'letter-name' : LATIN.test(name) ? 'dot-name' : 'dot-mask';
  return <span className={cn(style, className)}>{name}</span>;
}

/** Her avatar: her initial on the theme's gradient. The ring lights up and breathes while she speaks. */
export function Avatar({ name, speaking, className }: { name: string; speaking?: boolean; className?: string }) {
  const { theme } = useTheme();
  return (
    <span aria-hidden="true"
      className={cn(
        'grid flex-none place-items-center rounded-full bg-(image:--avatar-bg) text-(--avatar-ink) ring-1 ring-hairline transition-shadow duration-300',
        theme === 'her' ? 'letter-name' : 'font-mono font-bold',
        speaking && 'voice-ring',
        className,
      )}>
      {([...name][0] ?? '·').toUpperCase()}
    </span>
  );
}
