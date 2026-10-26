import type { ReplyLanguage } from '@shared/protocol';
import { Field } from '@/components/settings/Field';
import { choice } from '@/components/settings/choice';
import { useSay, useUi, type Said } from '@/lib/locale';

const OPTIONS: { id: ReplyLanguage; label: Said }[] = [
  { id: 'auto', label: { zh: '跟随对方', en: 'Follow you' } },
  { id: 'zh', label: { zh: '中文', en: 'Chinese' } },
  { id: 'en', label: { zh: '英文', en: 'English' } },
];

/** Which language she writes in. Separate from the voice's reading language, and from the app's own. */
export function ReplyLanguagePicker({ value, onChange }: { value: ReplyLanguage; onChange: (value: ReplyLanguage) => void }) {
  const ui = useUi();
  const say = useSay();
  return (
    <Field id="her-language" label={say('回复语言', 'Reply language')}>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby="her-language-label">
        {OPTIONS.map(o => (
          <button key={o.id} type="button" role="radio" aria-checked={value === o.id} onClick={() => onChange(o.id)}
            className={choice(value === o.id)}>
            {o.label[ui]}
          </button>
        ))}
      </div>
    </Field>
  );
}
