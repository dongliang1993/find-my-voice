import { choice } from '@/components/settings/choice';
import { Field } from '@/components/settings/Field';
import { useSay, useUi, type Said } from '@/lib/locale';

type Language = 'auto' | 'zh' | 'en';

const OPTIONS: { id: Language; label: Said }[] = [
  { id: 'zh', label: { zh: '中文', en: '中文' } },
  { id: 'en', label: { zh: '英文', en: 'English' } },
];

/**
 * The language the app's own words are in — the 外观 page's one setting.
 * Saved through `save({ ui: { language } })`; the words follow at once.
 */
export function UiLanguagePicker({ value, onChange }: { value: Language; onChange: (value: Language) => void }) {
  const ui = useUi();
  const say = useSay();
  return (
    <Field id="ui-language" label={say('语言', 'Language')}>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby="ui-language-label">
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
