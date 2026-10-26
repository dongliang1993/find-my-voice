import { ArrowUpRight } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { useSay } from '@/lib/locale';

type Props = { id: string; label: string; link?: string; linkLabel?: string; children: React.ReactNode };

/** `id` is the control's id; the label gets `${id}-label` so groups can reference it via aria-labelledby. */
export function Field({ id, label, link, linkLabel, children }: Props) {
  const say = useSay();
  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between">
        <Label htmlFor={id} id={`${id}-label`} className="text-[14px] font-normal text-foreground">{label}</Label>
        {link && (
          <a href={link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-[13px] text-muted-foreground hover:text-primary">
            {linkLabel ?? say('去哪里拿 Key', 'Get a key')} <ArrowUpRight className="size-3" />
          </a>
        )}
      </div>
      {children}
    </div>
  );
}
