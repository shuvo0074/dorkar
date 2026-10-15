import { useI18n } from '../../lib/i18n';
import { useCategory } from './categories';

/** Category attributes as definition-list rows, labelled from the category's schema. */
export function AttributeList({
  categoryId,
  values,
}: {
  categoryId: string;
  values: Record<string, unknown>;
}) {
  const { t, lang, num } = useI18n();
  const category = useCategory(categoryId);
  const props = category.data?.attributeSchema.properties ?? {};
  const rows = Object.entries(values).flatMap(([k, v]) => {
    if (v === null || v === undefined || v === '' || v === false) return [];
    const spec = props[k];
    const label = spec?.label[lang] ?? k;
    const unit =
      spec && (spec.type === 'integer' || spec.type === 'number') ? spec.unit : undefined;
    const text =
      v === true
        ? t('terms.yes')
        : typeof v === 'number'
          ? `${num(v)}${unit ? ` ${unit}` : ''}`
          : typeof v === 'string'
            ? v
            : JSON.stringify(v);
    return [{ k, label, text }];
  });
  return (
    <>
      {rows.map((r) => (
        <div key={r.k} className="facts__row">
          <dt>{r.label}</dt>
          <dd>{r.text}</dd>
        </div>
      ))}
    </>
  );
}
