import {
  Conditions,
  DeliveryModes,
  findContactInfo,
  type Condition,
  type DeliveryMode,
} from '@dorkar/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  MoneyField,
  Segmented,
  SelectField,
  TextAreaField,
  TextField,
} from '../components/forms/fields';
import { AlertIcon, NoteIcon } from '../components/glyphs/glyphs';
import { LedgerSkeleton, LoadError, SignedInOnly } from '../components/ui/Status';
import { useSession } from '../features/auth/session';
import { PhotoPicker } from '../features/media/Photos';
import { needsApi, type Need } from '../features/needs/api';
import { offersApi, type OfferInput } from '../features/offers/api';
import {
  offerTermsFromNeed,
  OfferTermsFields,
  readOfferTerms,
  type OfferTermsDraft,
} from '../features/offers/OfferTerms';
import { ApiError } from '../lib/http';
import { errorMessage } from '../lib/errors';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { asciiDigits, parseTaka, poisha } from '../lib/money';
import { useIntent } from '../lib/useIntent';

export default function OfferFormRoute() {
  const { id = '' } = useParams();
  return (
    <SignedInOnly from={`/needs/${id}/offer`}>
      <Loader id={id} />
    </SignedInOnly>
  );
}

function Loader({ id }: { id: string }) {
  const need = useQuery({ queryKey: ['needs', id], queryFn: () => needsApi.get(id) });
  if (need.isPending) return <LedgerSkeleton rows={6} />;
  if (need.isError) return <LoadError onRetry={() => void need.refetch()} />;
  return <OfferForm need={need.data} />;
}

const EXPIRY = ['24', '72', '168'] as const;

function OfferForm({ need }: { need: Need }) {
  const { t, num } = useI18n();
  const f = useFormat();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const session = useSession();
  const intent = useIntent();
  const remaining = Math.max(1, need.quantity - need.acceptedQuantity);
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState(String(remaining));
  const [condition, setCondition] = useState<Condition | ''>(need.condition[0] ?? '');
  const [method, setMethod] = useState<DeliveryMode>(
    need.mode === 'HIRE'
      ? 'ON_SITE'
      : need.deliveryPreference === 'PICKUP'
        ? 'BUYER_PICKUP'
        : 'SELLER_DELIVERY',
  );
  const [fee, setFee] = useState('');
  const [eta, setEta] = useState('');
  const [available, setAvailable] = useState('');
  const [terms, setTerms] = useState<OfferTermsDraft>(() =>
    offerTermsFromNeed(need.mode, need.modeTerms),
  );
  const [message, setMessage] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<(typeof EXPIRY)[number]>('72');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});

  const send = useMutation({
    mutationFn: (input: OfferInput) => offersApi.submit(need.id, input, intent.key),
    onSuccess: (offer) => {
      intent.renew();
      qc.setQueryData(['offers', offer.id], offer);
      void qc.invalidateQueries({ queryKey: ['me'] });
      void navigate(`/offers/${offer.id}`, { state: { notice: 'sent' } });
    },
  });

  const header = (
    <header className="desk__head">
      <p className="crumb">
        <Link to={`/needs/${need.id}`}>{need.title}</Link>
      </p>
      <h1 tabIndex={-1}>{t('offerForm.title')}</h1>
      <p className="desk__lede">{t('offerForm.lede')}</p>
      <p className="item__meta">
        {[
          f.place(need.location),
          f.range(need.budget.min, need.budget.max) ?? t('need.budget.none'),
        ].join(' · ')}
      </p>
    </header>
  );

  if (session.account?.id === need.requesterId || need.status !== 'OPEN') {
    return (
      <div className="formpage">
        {header}
        <p className="alert alert--note" role="status">
          <NoteIcon />
          <span>
            {t(session.account?.id === need.requesterId ? 'offerForm.own' : 'offerForm.closed')}
          </span>
        </p>
      </div>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string | undefined> = {};
    const p = parseTaka(price);
    if (p === null || p === 0) errs['price'] = t('common.badAmount');
    const q = Number(asciiDigits(quantity));
    if (!Number.isInteger(q) || q < 1) errs['quantity'] = t('common.badNumber');
    const feeP = fee.trim() ? parseTaka(fee) : null;
    if (fee.trim() && feeP === null) errs['fee'] = t('common.badAmount');
    const etaN = eta.trim() ? Number(asciiDigits(eta)) : null;
    if (etaN !== null && (!Number.isInteger(etaN) || etaN < 0 || etaN > 365))
      errs['eta'] = t('common.badNumber');
    if (findContactInfo(message)) errs['message'] = t('needForm.contact');
    const mt = readOfferTerms(need.mode, terms);
    for (const [k, key] of Object.entries(mt.errors)) errs[`terms.${k}`] = t(key);
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) {
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('.offerform [aria-invalid="true"]')?.focus(),
      );
      return;
    }
    send.mutate({
      price: poisha(p!),
      quantity: q,
      deliveryTerms: {
        method,
        ...(feeP !== null ? { feeAmount: feeP } : {}),
        ...(etaN !== null ? { etaDays: etaN } : {}),
      },
      ...(condition ? { condition } : {}),
      ...(available ? { availabilityFrom: available } : {}),
      modeTerms: mt.value,
      ...(message.trim() ? { description: message.trim() } : {}),
      ...(photos.length ? { attachmentMediaIds: photos } : {}),
      expiresInHours: Number(expiry),
    });
  };

  const termErrors = Object.fromEntries(
    Object.entries(errors)
      .filter(([k]) => k.startsWith('terms.'))
      .map(([k, v]) => [k.slice(6), v]),
  );

  return (
    <div className="formpage offerform">
      {header}
      <form onSubmit={submit} noValidate>
        <section className="formsec" aria-labelledby="of-1">
          <h2 id="of-1">
            <span className="formsec__n" aria-hidden="true">
              1
            </span>
            {t('offer.price')}
          </h2>
          <div className="pair">
            <MoneyField
              label={t('offerForm.price')}
              hint={t('offerForm.priceHint')}
              value={price}
              onChange={setPrice}
              error={errors['price']}
            />
            <TextField
              label={t('offerForm.quantity')}
              hint={t('offerForm.quantityHint', { n: num(need.quantity) })}
              inputMode="numeric"
              value={quantity}
              onChange={setQuantity}
              error={errors['quantity']}
            />
          </div>
          {need.mode !== 'HIRE' && (
            <SelectField
              label={t('offerForm.condition')}
              value={condition}
              onChange={(v) => setCondition(v as Condition | '')}
              placeholder={t('offerForm.conditionPick')}
              options={Conditions.map((c) => ({ value: c, label: f.condition(c) }))}
            />
          )}
          <OfferTermsFields
            mode={need.mode}
            draft={terms}
            onChange={setTerms}
            errors={termErrors}
          />
        </section>

        <section className="formsec" aria-labelledby="of-2">
          <h2 id="of-2">
            <span className="formsec__n" aria-hidden="true">
              2
            </span>
            {t('offerForm.delivery')}
          </h2>
          <SelectField
            label={t('offerForm.delivery')}
            value={method}
            onChange={(v) => setMethod(v as DeliveryMode)}
            options={DeliveryModes.map((d) => ({ value: d, label: f.delivery(d) }))}
          />
          <div className="pair">
            <MoneyField
              label={t('offerForm.fee')}
              optional
              value={fee}
              onChange={setFee}
              error={errors['fee']}
            />
            <TextField
              label={t('offerForm.eta')}
              optional
              inputMode="numeric"
              value={eta}
              onChange={setEta}
              error={errors['eta']}
            />
          </div>
          <TextField
            type="date"
            label={t('offerForm.available')}
            optional
            value={available}
            onChange={setAvailable}
          />
        </section>

        <section className="formsec" aria-labelledby="of-3">
          <h2 id="of-3">
            <span className="formsec__n" aria-hidden="true">
              3
            </span>
            {t('offerForm.send')}
          </h2>
          <TextAreaField
            label={t('offerForm.message')}
            optional
            hint={t('offerForm.messageHint')}
            value={message}
            onChange={setMessage}
            maxLength={2000}
            error={errors['message']}
          />
          <PhotoPicker purpose="OFFER" value={photos} onChange={setPhotos} max={5} />
          <Segmented
            legend={t('offerForm.expires')}
            name="offer-expiry"
            value={expiry}
            onChange={setExpiry}
            options={EXPIRY.map((h) => ({ value: h, label: t(`offerForm.expires.${h}`) }))}
          />
          {send.isError && (
            <p className="alert" role="alert">
              <AlertIcon />
              <span>
                {send.error instanceof ApiError && send.error.code === 'VERIFICATION_REQUIRED'
                  ? t('offerForm.verify')
                  : errorMessage(send.error, t)}
              </span>
            </p>
          )}
          <div className="formactions">
            <button type="submit" className="btn" disabled={send.isPending}>
              {send.isPending ? t('offerForm.sending') : t('offerForm.send')}
            </button>
          </div>
        </section>
      </form>
    </div>
  );
}
