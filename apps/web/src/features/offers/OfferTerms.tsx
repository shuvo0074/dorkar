import type { NeedMode } from '@dorkar/contracts';
import { CheckField, MoneyField, TextAreaField, TextField } from '../../components/forms/fields';
import { useFormat } from '../../lib/format';
import { useI18n, type MessageKey } from '../../lib/i18n';
import { asciiDigits, parseTaka, takaInput } from '../../lib/money';
import { localInput } from '../needs/NeedTerms';

/** An offer's mode terms as typed. Not the same shape as a need's terms (see the API). */
export type OfferTermsDraft = Record<string, string | boolean>;

/** Start an offer's terms from what the need asked for. */
export function offerTermsFromNeed(mode: NeedMode, need: Record<string, unknown>): OfferTermsDraft {
  const s = (k: string) => (typeof need[k] === 'string' ? (need[k]) : '');
  switch (mode) {
    case 'RENT':
      return { startAt: localInput(need['startAt']), endAt: localInput(need['endAt']) };
    case 'BORROW':
      return { returnBy: s('returnBy').slice(0, 10) };
    case 'HIRE':
      return { serviceDate: s('serviceDate') };
    default:
      return {};
  }
}

export function offerTermsDraft(_mode: NeedMode, terms: Record<string, unknown>): OfferTermsDraft {
  const out: OfferTermsDraft = {};
  for (const [k, v] of Object.entries(terms)) {
    if (typeof v === 'boolean') out[k] = v;
    else if (k === 'startAt' || k === 'endAt') out[k] = localInput(v);
    else if (k === 'depositAmount' && typeof v === 'number') out[k] = takaInput(v);
    else if (typeof v === 'string' || typeof v === 'number') out[k] = String(v);
  }
  return out;
}

export function readOfferTerms(
  mode: NeedMode,
  d: OfferTermsDraft,
): { value: Record<string, unknown>; errors: Record<string, MessageKey> } {
  const errors: Record<string, MessageKey> = {};
  const value: Record<string, unknown> = {};
  const str = (k: string) => {
    const v = d[k];
    return typeof v === 'string' ? v.trim() : '';
  };
  const int = (k: string, max: number, required = false) => {
    const v = str(k);
    if (!v) {
      if (required) errors[k] = 'common.required';
      return;
    }
    const n = Number(asciiDigits(v));
    if (!Number.isInteger(n) || n < 0 || n > max) errors[k] = 'common.badNumber';
    else value[k] = n;
  };
  const moment = (k: string) => {
    const v = str(k);
    const ms = v ? new Date(v).getTime() : NaN;
    if (!v) errors[k] = 'common.required';
    else if (Number.isNaN(ms)) errors[k] = 'common.badDate';
    else value[k] = new Date(ms).toISOString();
  };
  const deposit = () => {
    const v = str('depositAmount');
    if (!v) return;
    const p = parseTaka(v);
    if (p === null) errors['depositAmount'] = 'common.badAmount';
    else value['depositAmount'] = p;
  };

  switch (mode) {
    case 'BUY':
      int('warrantyMonths', 120);
      break;
    case 'RENT':
      moment('startAt');
      moment('endAt');
      if (value['startAt'] && value['endAt'] && value['endAt'] <= value['startAt'])
        errors['endAt'] = 'common.badRange';
      deposit();
      break;
    case 'BORROW':
      if (!str('returnBy')) errors['returnBy'] = 'common.required';
      else value['returnBy'] = str('returnBy');
      deposit();
      break;
    case 'HIRE': {
      if (!str('serviceDate')) errors['serviceDate'] = 'common.required';
      else value['serviceDate'] = str('serviceDate');
      const h = str('durationHours');
      if (h) {
        const n = Number(asciiDigits(h));
        if (!Number.isFinite(n) || n <= 0 || n > 720) errors['durationHours'] = 'common.badNumber';
        else value['durationHours'] = n;
      }
      const scope = str('scope');
      if (scope.length < 3) errors['scope'] = 'common.required';
      else value['scope'] = scope.slice(0, 1000);
      break;
    }
    case 'SOURCE':
      int('leadTimeDays', 365, true);
      if (d['sampleAvailable'] === true) value['sampleAvailable'] = true;
      if (d['specificationsConfirmed'] === true) value['specificationsConfirmed'] = true;
      break;
  }
  return { value, errors };
}

export function OfferTermsFields({
  mode,
  draft,
  onChange,
  errors,
}: {
  mode: NeedMode;
  draft: OfferTermsDraft;
  onChange: (d: OfferTermsDraft) => void;
  errors: Record<string, string | undefined>;
}) {
  const { t } = useI18n();
  const s = (k: string) => {
    const v = draft[k];
    return typeof v === 'string' ? v : '';
  };
  const set = (k: string) => (v: string | boolean) => onChange({ ...draft, [k]: v });

  switch (mode) {
    case 'BUY':
      return (
        <TextField
          label={t('offerTerms.warrantyMonths')}
          optional
          inputMode="numeric"
          value={s('warrantyMonths')}
          onChange={set('warrantyMonths')}
          error={errors['warrantyMonths']}
        />
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
              error={errors['startAt']}
            />
            <TextField
              type="datetime-local"
              label={t('terms.endAt')}
              value={s('endAt')}
              onChange={set('endAt')}
              error={errors['endAt']}
            />
          </div>
          <MoneyField
            label={t('offerTerms.deposit')}
            optional
            value={s('depositAmount')}
            onChange={set('depositAmount')}
            error={errors['depositAmount']}
          />
        </>
      );
    case 'BORROW':
      return (
        <div className="pair">
          <TextField
            type="date"
            label={t('terms.returnBy')}
            value={s('returnBy')}
            onChange={set('returnBy')}
            error={errors['returnBy']}
          />
          <MoneyField
            label={t('offerTerms.deposit')}
            optional
            value={s('depositAmount')}
            onChange={set('depositAmount')}
            error={errors['depositAmount']}
          />
        </div>
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
              error={errors['serviceDate']}
            />
            <TextField
              label={t('offerTerms.durationHours')}
              optional
              inputMode="decimal"
              value={s('durationHours')}
              onChange={set('durationHours')}
              error={errors['durationHours']}
            />
          </div>
          <TextAreaField
            label={t('offerTerms.scope')}
            hint={t('offerTerms.scopeHint')}
            value={s('scope')}
            onChange={set('scope')}
            maxLength={1000}
            error={errors['scope']}
          />
        </>
      );
    case 'SOURCE':
      return (
        <>
          <TextField
            label={t('offerTerms.leadTimeDays')}
            inputMode="numeric"
            value={s('leadTimeDays')}
            onChange={set('leadTimeDays')}
            error={errors['leadTimeDays']}
          />
          <CheckField
            label={t('offerTerms.sampleAvailable')}
            checked={draft['sampleAvailable'] === true}
            onChange={set('sampleAvailable')}
          />
          <CheckField
            label={t('offerTerms.specificationsConfirmed')}
            checked={draft['specificationsConfirmed'] === true}
            onChange={set('specificationsConfirmed')}
          />
        </>
      );
  }
}

const LABELS: Record<string, MessageKey> = {
  warrantyMonths: 'offerTerms.warrantyMonths',
  startAt: 'terms.startAt',
  endAt: 'terms.endAt',
  returnBy: 'terms.returnBy',
  depositAmount: 'offerTerms.deposit',
  serviceDate: 'terms.serviceDate',
  durationHours: 'offerTerms.durationHours',
  scope: 'offerTerms.scope',
  leadTimeDays: 'offerTerms.leadTimeDays',
  sampleAvailable: 'offerTerms.sampleAvailable',
  specificationsConfirmed: 'offerTerms.specificationsConfirmed',
};

export function OfferTermsList({ terms }: { terms: Record<string, unknown> }) {
  const { t, date, num } = useI18n();
  const f = useFormat();
  const rows = Object.entries(terms).flatMap(([k, v]) => {
    const label = LABELS[k];
    if (!label || v === false || v === null || v === undefined) return [];
    let text: string;
    if (v === true) text = t('terms.yes');
    else if (k === 'depositAmount' && typeof v === 'number') text = f.taka(v);
    else if ((k === 'startAt' || k === 'endAt') && typeof v === 'string') text = date(v);
    else if ((k === 'returnBy' || k === 'serviceDate') && typeof v === 'string')
      text = date(v, 'short');
    else if (typeof v === 'number') text = num(v);
    else if (typeof v === 'string') text = v;
    else return [];
    return [{ k, label: t(label), text }];
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
