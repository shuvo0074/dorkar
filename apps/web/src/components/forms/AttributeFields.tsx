import { validateAttributes, type AttributeSchema, type AttributeValues } from '@dorkar/contracts';
import { asciiDigits } from '../../lib/money';
import { useI18n } from '../../lib/i18n';
import { CheckField, SelectField, TextField } from './fields';

/** Form state for category attributes: text as typed, booleans as booleans. */
export type AttributeDraft = Record<string, string | boolean>;

export function draftFromValues(values: Record<string, unknown> | undefined): AttributeDraft {
  const out: AttributeDraft = {};
  for (const [k, v] of Object.entries(values ?? {})) {
    if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' || typeof v === 'number') out[k] = String(v);
  }
  return out;
}

/**
 * Converts the draft to typed values and validates it with the same function the server uses.
 * Empty fields are left out. Errors are keyed by attribute.
 */
export function readAttributes(
  schema: AttributeSchema,
  draft: AttributeDraft,
  opts: { partial?: boolean } = {},
): { value: AttributeValues; errors: Record<string, string> } {
  const raw: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(schema.properties)) {
    const v = draft[key];
    if (v === undefined || v === '') continue;
    if (spec.type === 'boolean') raw[key] = v === true;
    else if (spec.type === 'integer' || spec.type === 'number') {
      const n = Number(asciiDigits(String(v)).replace(/,/g, ''));
      raw[key] = Number.isFinite(n) ? n : String(v);
    } else raw[key] = String(v);
  }
  const result = validateAttributes(schema, raw, opts);
  if (result.ok) return { value: result.value, errors: {} };
  const errors: Record<string, string> = {};
  for (const i of result.issues) errors[i.path] ??= i.message;
  return { value: {}, errors };
}

/** The category's own questions (brand, storage, skills…), rendered from its schema. */
export function AttributeFields({
  schema,
  draft,
  onChange,
  errors = {},
  partial = false,
}: {
  schema: AttributeSchema;
  draft: AttributeDraft;
  onChange: (next: AttributeDraft) => void;
  errors?: Record<string, string>;
  /** Needs leave every attribute optional; listings must answer the required ones. */
  partial?: boolean;
}) {
  const { t, lang, num } = useI18n();
  const entries = Object.entries(schema.properties);
  if (entries.length === 0) return null;
  const set = (k: string, v: string | boolean) => onChange({ ...draft, [k]: v });

  return (
    <div className="attrs">
      {entries.map(([key, spec]) => {
        const label = spec.label[lang];
        const optional = partial || !schema.required.includes(key);
        const error = errors[key];
        switch (spec.type) {
          case 'boolean':
            return (
              <CheckField
                key={key}
                label={label}
                checked={draft[key] === true}
                onChange={(v) => set(key, v)}
              />
            );
          case 'string':
            return spec.enum ? (
              <SelectField
                key={key}
                label={label}
                optional={optional}
                value={String(draft[key] ?? '')}
                onChange={(v) => set(key, v)}
                placeholder={t('common.any')}
                options={spec.enum.map((e) => ({ value: e, label: e }))}
                error={error}
              />
            ) : (
              <TextField
                key={key}
                label={label}
                optional={optional}
                value={String(draft[key] ?? '')}
                onChange={(v) => set(key, v)}
                maxLength={spec.maxLength ?? 200}
                error={error}
              />
            );
          case 'integer':
          case 'number': {
            const bounds =
              spec.minimum !== undefined && spec.maximum !== undefined
                ? t('common.range', { min: num(spec.minimum), max: num(spec.maximum) })
                : undefined;
            return (
              <TextField
                key={key}
                label={spec.unit ? `${label} (${spec.unit})` : label}
                optional={optional}
                value={String(draft[key] ?? '')}
                onChange={(v) => set(key, v)}
                inputMode={spec.type === 'integer' ? 'numeric' : 'decimal'}
                hint={bounds}
                error={error}
              />
            );
          }
        }
      })}
    </div>
  );
}
