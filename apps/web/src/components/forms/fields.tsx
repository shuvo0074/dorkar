import { Districts, Divisions } from '@dorkar/contracts';
import { useId, type ReactNode } from 'react';
import { AlertIcon } from '../glyphs/glyphs';
import { useI18n } from '../../lib/i18n';

/**
 * Printed form parts: a label in Anton, one ruled control, a hint and an inline error.
 * Controlled components; the page owns the state and the validation.
 */
interface Base {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  optional?: boolean;
  compact?: boolean;
}

function Shell({
  id,
  label,
  hint,
  error,
  optional,
  compact,
  prefix,
  children,
}: Base & { id: string; prefix?: ReactNode; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div
      className={compact ? 'field field--compact' : 'field'}
      data-invalid={error ? '' : undefined}
    >
      <label className="label" htmlFor={id}>
        {label}
        {optional && <span className="field__opt"> ({t('common.optional')})</span>}
      </label>
      <div className="field__control">
        {prefix && <span className="field__prefix">{prefix}</span>}
        {children}
      </div>
      {hint && (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field__error" id={`${id}-error`}>
          <AlertIcon />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

const describedBy = (id: string, hint?: string, error?: string) =>
  [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;

export function TextField({
  value,
  onChange,
  type = 'text',
  maxLength,
  placeholder,
  inputMode,
  autoComplete,
  prefix,
  ...base
}: Base & {
  value: string;
  onChange: (v: string) => void;
  type?: 'text' | 'date' | 'datetime-local' | 'number' | 'search';
  maxLength?: number;
  placeholder?: string;
  inputMode?: 'text' | 'numeric' | 'decimal';
  autoComplete?: string;
  prefix?: ReactNode;
}) {
  const id = useId();
  return (
    <Shell id={id} prefix={prefix} {...base}>
      <input
        id={id}
        type={type}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        inputMode={inputMode}
        autoComplete={autoComplete ?? 'off'}
        aria-invalid={base.error ? true : undefined}
        aria-describedby={describedBy(id, base.hint, base.error)}
        onChange={(e) => onChange(e.target.value)}
      />
    </Shell>
  );
}

export function TextAreaField({
  value,
  onChange,
  maxLength,
  placeholder,
  rows,
  ...base
}: Base & {
  value: string;
  onChange: (v: string) => void;
  maxLength?: number;
  placeholder?: string;
  rows?: number;
}) {
  const id = useId();
  return (
    <Shell id={id} {...base}>
      <textarea
        id={id}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        rows={rows}
        aria-invalid={base.error ? true : undefined}
        aria-describedby={describedBy(id, base.hint, base.error)}
        onChange={(e) => onChange(e.target.value)}
      />
    </Shell>
  );
}

export function SelectField({
  value,
  onChange,
  options,
  placeholder,
  lang,
  ...base
}: Base & {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string; group?: string }>;
  /** First, empty choice ("Any", "Choose…"); omit to force a value. */
  placeholder?: string;
  lang?: string;
}) {
  const id = useId();
  const groups = [...new Set(options.map((o) => o.group).filter(Boolean))] as string[];
  const opt = (o: { value: string; label: string }) => (
    <option key={o.value} value={o.value}>
      {o.label}
    </option>
  );
  return (
    <Shell id={id} {...base}>
      <select
        id={id}
        value={value}
        lang={lang}
        aria-invalid={base.error ? true : undefined}
        aria-describedby={describedBy(id, base.hint, base.error)}
        onChange={(e) => onChange(e.target.value)}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {groups.length > 0
          ? groups.map((g) => (
              <optgroup key={g} label={g}>
                {options.filter((o) => o.group === g).map(opt)}
              </optgroup>
            ))
          : options.map(opt)}
      </select>
    </Shell>
  );
}

/** Taka amount typed as text (Bangla digits and commas welcome); the page parses with parseTaka. */
export function MoneyField(
  props: Base & { value: string; onChange: (v: string) => void; placeholder?: string },
) {
  return <TextField {...props} inputMode="decimal" prefix="৳" />;
}

/** All 64 districts, grouped by division, named in the page language. */
export function DistrictField({
  value,
  onChange,
  placeholder,
  ...base
}: Base & { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const { lang } = useI18n();
  const options = Object.entries(Districts)
    .map(([slug, d]) => ({
      value: slug,
      label: d[lang],
      group: Divisions[d.division][lang],
    }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
  return (
    <SelectField
      {...base}
      value={value}
      onChange={onChange}
      options={options}
      {...(placeholder !== undefined ? { placeholder } : {})}
    />
  );
}

/** A ruled set of checkboxes (conditions, delivery modes, roles). */
export function CheckGroup<V extends string>({
  legend,
  options,
  value,
  onChange,
  hint,
  error,
}: {
  legend: string;
  options: Array<{ value: V; label: string }>;
  value: V[];
  onChange: (v: V[]) => void;
  hint?: string;
  error?: string | undefined;
}) {
  return (
    <fieldset className="checks" data-invalid={error ? '' : undefined}>
      <legend className="label">{legend}</legend>
      <div className="checks__row">
        {options.map((o) => (
          <label key={o.value} className="check">
            <input
              type="checkbox"
              checked={value.includes(o.value)}
              onChange={(e) =>
                onChange(
                  e.target.checked ? [...value, o.value] : value.filter((v) => v !== o.value),
                )
              }
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      {hint && <p className="field__hint">{hint}</p>}
      {error && (
        <p className="field__error">
          <AlertIcon />
          <span>{error}</span>
        </p>
      )}
    </fieldset>
  );
}

/** One yes/no box with its sentence beside it. */
export function CheckField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="check check--line">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** A segmented single choice, as on the desk: real radios under printed cells. */
export function Segmented<V extends string>({
  legend,
  name,
  options,
  value,
  onChange,
  hideLegend,
}: {
  legend: string;
  name: string;
  options: Array<{ value: V; label: string }>;
  value: V;
  onChange: (v: V) => void;
  hideLegend?: boolean;
}) {
  return (
    <fieldset className="segmented">
      <legend className={hideLegend ? 'visually-hidden' : 'label'}>{legend}</legend>
      {options.map((o) => (
        <label key={o.value}>
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </fieldset>
  );
}
