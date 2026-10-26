import { cn } from '@/lib/utils';

/**
 * The one selected look for every list and choice in every app — a nav, a
 * letter, a provider, a mode: a wash of the seal's red with its dark red on
 * top. No border, ever: the selected wash and the hover grey are the whole
 * look, so the two are never confused.
 */
export const choice = (on: boolean, shape: 'pill' | 'row' = 'pill') => cn(
  'text-left text-[14px] transition-colors duration-200',
  shape === 'pill' ? 'rounded-md px-3.5 py-1.5' : 'rounded-md px-3 py-2',
  on ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-wash-strong hover:text-foreground',
);
