import type { ComponentProps } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** A secondary choice on the mat: plain text, no box. */
export function Quiet({ className, ...props }: ComponentProps<typeof Button>) {
  return <Button type="button" variant="ghost" className={cn('h-8 rounded-full px-3 text-[13px] text-muted-foreground hover:text-foreground', className)} {...props} />;
}
