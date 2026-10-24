import type { ReplyLanguage } from '@shared/protocol';
import { Field } from '@/components/settings/Field';
import { cn } from '@/lib/utils';

const OPTIONS: { id: ReplyLanguage; label: string }[] = [
  { id: 'auto', label: '跟随对方' },
  { id: 'zh', label: '中文' },
  { id: 'en', label: '英文' },
];

/** Which language she writes in. Separate from the voice's reading language. */
export function ReplyLanguagePicker({ value, onChange }: { value: ReplyLanguage; onChange: (value: ReplyLanguage) => void }) {
  return (
    <Field id="her-language" label="回复语言">
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby="her-language-label">
        {OPTIONS.map(o => (
          <button key={o.id} type="button" role="radio" aria-checked={value === o.id} onClick={() => onChange(o.id)}
            className={cn('rounded-full border px-3 py-1 text-xs transition-colors',
              value === o.id ? 'border-primary/60 text-primary' : 'border-border text-muted-foreground hover:text-foreground')}>
            {o.label}
          </button>
        ))}
      </div>
    </Field>
  );
}
