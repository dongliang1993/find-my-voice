import { ArrowUpRight } from 'lucide-react';
import { Label } from '@/components/ui/label';

type Props = { id: string; label: string; optional?: boolean; link?: string; linkLabel?: string; children: React.ReactNode };

/** `id` is the control's id; the label gets `${id}-label` so groups can reference it via aria-labelledby. */
export function Field({ id, label, optional, link, linkLabel = '去哪里拿 Key', children }: Props) {
  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between">
        <Label htmlFor={id} id={`${id}-label`} className="text-muted-foreground">
          {label}
          {optional && <span className="text-xs font-normal text-muted-foreground/70">可选</span>}
        </Label>
        {link && (
          <a href={link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-xs text-primary hover:underline">
            {linkLabel} <ArrowUpRight className="size-3" />
          </a>
        )}
      </div>
      {children}
    </div>
  );
}
