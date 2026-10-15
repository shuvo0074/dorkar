import type { NeedMode } from '@dorkar/contracts';
import { CheckField, SelectField, TextAreaField, TextField } from '../../components/forms/fields';
import { asciiDigits } from '../../lib/money';
import { useI18n, type MessageKey } from '../../lib/i18n';
import { ServiceWindows } from './api';

/** Mode-specific terms as typed in the form. */
export type TermsDraft = Record<string, string | boolean>;

/** `datetime-local` value ("2026-10-20T09:00") for an ISO moment, in the viewer's zone. */
export function localInput(iso: unknown): string {
  if (typeof iso !== 'string') return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const off = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

const toIso = (local: string) => {
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export function termsDraftFrom(mode: NeedMode, terms: Record<string, unknown>): TermsDraft {
  const out: TermsDraft = {};
  for (const [k, v] of Object.entries(terms)) {
    if (typeof v === 'boolean') out[k] = v;
    else if (k === 'startAt' || k === 'endAt' || (k === 'returnBy' && mode === 'BORROW'))
      out[k] = localInput(v);
    else if (Array.isArray(v)) out[k] = v.join(', ');
    else if (typeof v === 'string' || typeof v === 'number') out[k] = String(v);
  }
  return out;
}

type Errors = Record<string, MessageKey>;

/** The need's `modeTerms` for the API, or field errors. Mirrors the server's per-mode schema. */
export function readNeedTerms(
  mode: NeedMode,
  d: TermsDraft,
): { value: Record<string, unknown>; errors: Errors } {
  const errors: Errors = {};
  const value: Record<string, unknown> = {};
  const str = (k: string) => {
    const v = d[k];
    return typeof v === 'string' ? v.trim() : '';
  };
  const bool = (k: string) => {
    if (d[k] === true) value[k] = true;
  };
  const text = (k: string, max: number, required = false) => {
    const v = str(k);
    if (!v) {
      if (required) errors[k] = 'common.required';
      return;
    }
    if (v.length > max) errors[k] = 'common.tooLong';
    else value[k] = v;
  };
  const moment = (k: string, required: boolean) => {
    const v = str(k);
    if (!v) {
      if (required) errors[k] = 'common.required';
      return;
    }
    const iso = toIso(v);
    if (!iso) errors[k] = 'common.badDate';
    else value[k] = iso;
  };
  const day = (k: string, required: boolean) => {
    const v = str(k);
    if (!v) {
      if (required) errors[k] = 'common.required';
      return;
    }
    value[k] = v;
  };

  switch (mode) {
    case 'BUY':
      bool('acceptsUsed');
      bool('warrantyRequired');
      break;
    case 'RENT':
      moment('startAt', true);
      moment('endAt', true);
      if (value['startAt'] && value['endAt'] && value['endAt'] <= value['startAt'])
        errors['endAt'] = 'common.badRange';
      bool('depositAcceptable');
      break;
    case 'BORROW':
      moment('startAt', true);
      moment('returnBy', true);
      if (value['startAt'] && value['returnBy'] && value['returnBy'] <= value['startAt'])
        errors['returnBy'] = 'common.badRange';
      text('purpose', 500);
      bool('depositOffered');
      break;
    case 'HIRE': {
      day('serviceDate', true);
      const w = str('serviceWindow');
      if (w) value['serviceWindow'] = w;
      const hours = str('durationEstimateHours');
      if (hours) {
        const n = Number(asciiDigits(hours));
        if (!Number.isFinite(n) || n <= 0 || n > 720)
          errors['durationEstimateHours'] = 'common.badNumber';
        else value['durationEstimateHours'] = n;
      }
      bool('onSite');
      const skills = str('skills')
        .split(/[,،]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (skills.length > 20 || skills.some((s) => s.length > 40))
        errors['skills'] = 'common.tooLong';
      else if (skills.length) value['skills'] = skills;
      break;
    }
    case 'SOURCE':
      text('specifications', 2000, true);
      text('customization', 1000);
      text('qualityRequirements', 1000);
      bool('sampleRequired');
      text('supplierRequirements', 1000);
      day('deliveryDeadline', false);
      break;
  }
  return { value, errors };
}

/** The questions that only make sense for one mode (rental dates, job day, specifications…). */
export function NeedTermsFields({
  mode,
  draft,
  onChange,
  errors,
}: {
  mode: NeedMode;
  draft: TermsDraft;
  onChange: (d: TermsDraft) => void;
  /** Already translated, keyed by term. */
  errors: Record<string, string | undefined>;
}) {
  const { t } = useI18n();
  const s = (k: string) => {
    const v = draft[k];
    return typeof v === 'string' ? v : '';
  };
  const set = (k: string) => (v: string | boolean) => onChange({ ...draft, [k]: v });
  const err = (k: string) => errors[k];
  const check = (k: string, label: MessageKey) => (
    <CheckField label={t(label)} checked={draft[k] === true} onChange={set(k)} />
  );

  switch (mode) {
    case 'BUY':
      return (
        <div className="checks__row">
          {check('acceptsUsed', 'terms.acceptsUsed')}
          {check('warrantyRequired', 'terms.warrantyRequired')}
        </div>
      );
    case 'RENT':
      return (
        <>
          <div className="pair">
            <TextField
              type="datetime-local"
              label={t('terms.startAt')}
              value={s('startAt')}
              onChange={set('startAt')}
              error={err('startAt')}
            />
            <TextField
              type="datetime-local"
              label={t('terms.endAt')}
              value={s('endAt')}
              onChange={set('endAt')}
              error={err('endAt')}
            />
          </div>
          {check('depositAcceptable', 'terms.depositAcceptable')}
        </>
      );
    case 'BORROW':
      return (
        <>
          <div className="pair">
            <TextField
              type="datetime-local"
              label={t('terms.startAt')}
              value={s('startAt')}
              onChange={set('startAt')}
              error={err('startAt')}
            />
            <TextField
              type="datetime-local"
              label={t('terms.returnBy')}
              value={s('returnBy')}
              onChange={set('returnBy')}
              error={err('returnBy')}
            />
          </div>
          <TextField
            label={t('terms.purpose')}
            optional
            value={s('purpose')}
            onChange={set('purpose')}
            maxLength={500}
            error={err('purpose')}
          />
          {check('depositOffered', 'terms.depositOffered')}
        </>
      );
    case 'HIRE':
      return (
        <>
          <div className="pair">
            <TextField
              type="date"
              label={t('terms.serviceDate')}
              value={s('serviceDate')}
              onChange={set('serviceDate')}
              error={err('serviceDate')}
            />
            <SelectField
              label={t('terms.serviceWindow')}
              value={s('serviceWindow')}
              onChange={set('serviceWindow')}
              placeholder={t('terms.window.ANY')}
              options={ServiceWindows.filter((w) => w !== 'ANY').map((w) => ({
                value: w,
                label: t(`terms.window.${w}`),
              }))}
            />
          </div>
          <TextField
            label={t('terms.duration')}
            optional
            inputMode="decimal"
            value={s('durationEstimateHours')}
            onChange={set('durationEstimateHours')}
            error={err('durationEstimateHours')}
          />
          <TextField
            label={t('terms.skills')}
            optional
            hint={t('terms.skillsHint')}
            value={s('skills')}
            onChange={set('skills')}
            error={err('skills')}
          />
          {check('onSite', 'terms.onSite')}
        </>
      );
    case 'SOURCE':
      return (
        <>
          <TextAreaField
            label={t('terms.specifications')}
            hint={t('terms.specificationsHint')}
            value={s('specifications')}
            onChange={set('specifications')}
            maxLength={2000}
            error={err('specifications')}
          />
          <TextField
            label={t('terms.customization')}
            optional
            value={s('customization')}
            onChange={set('customization')}
            maxLength={1000}
          />
          <TextField
            label={t('terms.quality')}
            optional
            value={s('qualityRequirements')}
            onChange={set('qualityRequirements')}
            maxLength={1000}
          />
          <TextField
            label={t('terms.supplier')}
            optional
            value={s('supplierRequirements')}
            onChange={set('supplierRequirements')}
            maxLength={1000}
          />
          <TextField
            type="date"
            label={t('terms.deliveryDeadline')}
            optional
            value={s('deliveryDeadline')}
            onChange={set('deliveryDeadline')}
          />
          {check('sampleRequired', 'terms.sampleRequired')}
        </>
      );
  }
}

const TERM_LABELS: Record<string, MessageKey> = {
  acceptsUsed: 'terms.acceptsUsed',
  warrantyRequired: 'terms.warrantyRequired',
  startAt: 'terms.startAt',
  endAt: 'terms.endAt',
  returnBy: 'terms.returnBy',
  depositAcceptable: 'terms.depositAcceptable',
  depositOffered: 'terms.depositOffered',
  purpose: 'terms.purpose',
  serviceDate: 'terms.serviceDate',
  serviceWindow: 'terms.serviceWindow',
  durationEstimateHours: 'terms.duration',
  onSite: 'terms.onSite',
  skills: 'terms.skills',
  specifications: 'terms.specifications',
  customization: 'terms.customization',
  qualityRequirements: 'terms.quality',
  sampleRequired: 'terms.sampleRequired',
  supplierRequirements: 'terms.supplier',
  deliveryDeadline: 'terms.deliveryDeadline',
};

/** A need's mode terms as definition-list rows, in the page language. */
export function NeedTermsList({ terms }: { terms: Record<string, unknown> }) {
  const { t, date, num } = useI18n();
  const rows = Object.entries(terms).flatMap(([k, v]) => {
    const label = TERM_LABELS[k];
    if (!label || v === false || v === null || v === undefined) return [];
    let text: string;
    if (v === true) text = t('terms.yes');
    else if (k === 'serviceWindow' && typeof v === 'string') text = t(`terms.window.${v as 'ANY'}`);
    else if ((k === 'startAt' || k === 'endAt' || k === 'returnBy') && typeof v === 'string')
      text = v.length > 10 ? date(v) : date(v, 'short');
    else if ((k === 'serviceDate' || k === 'deliveryDeadline') && typeof v === 'string')
      text = date(v, 'short');
    else if (Array.isArray(v)) text = v.join(', ');
    else if (typeof v === 'number') text = num(v);
    else if (typeof v === 'string') text = v;
    else return [];
    return [{ k, label: t(label), text }];
  });
  if (rows.length === 0) return null;
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
