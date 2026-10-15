import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { MoneyField, TextField } from '../components/forms/fields';
import { AlertIcon, NoteIcon } from '../components/glyphs/glyphs';
import { LedgerSkeleton, SignedInOnly } from '../components/ui/Status';
import { auctionsApi, type AuctionInput, type AuctionKind } from '../features/auctions/api';
import { catalogApi } from '../features/catalog/api';
import { needsApi } from '../features/needs/api';
import { errorMessage } from '../lib/errors';
import { useI18n } from '../lib/i18n';
import { asciiDigits, parseTaka, poisha } from '../lib/money';
import { useIntent } from '../lib/useIntent';

export default function AuctionFormRoute() {
  const [params] = useSearchParams();
  const listingId = params.get('listing');
  const needId = params.get('need');
  return (
    <SignedInOnly from={`/auctions/new?${params.toString()}`}>
      <Subject listingId={listingId} needId={needId} />
    </SignedInOnly>
  );
}

function Subject({ listingId, needId }: { listingId: string | null; needId: string | null }) {
  const { t } = useI18n();
  const listing = useQuery({
    queryKey: ['listings', listingId],
    queryFn: () => catalogApi.listing(listingId!),
    enabled: Boolean(listingId),
  });
  const need = useQuery({
    queryKey: ['needs', needId],
    queryFn: () => needsApi.get(needId!),
    enabled: Boolean(needId),
  });
  if (!listingId && !needId)
    return (
      <div className="formpage">
        <p className="alert alert--note">
          <NoteIcon />
          <span>{t('auctionForm.missing')}</span>
        </p>
      </div>
    );
  if (listing.isPending && need.isPending) return <LedgerSkeleton rows={5} />;
  if (listing.data)
    return (
      <AuctionForm
        kind="FORWARD"
        subjectId={listing.data.id}
        title={listing.data.title}
        back={`/listings/${listing.data.id}`}
      />
    );
  if (need.data)
    return (
      <AuctionForm
        kind="REVERSE"
        subjectId={need.data.id}
        title={need.data.title}
        back={`/needs/${need.data.id}`}
      />
    );
  return <LedgerSkeleton rows={5} />;
}

function AuctionForm({
  kind,
  subjectId,
  title,
  back,
}: {
  kind: AuctionKind;
  subjectId: string;
  title: string;
  back: string;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const intent = useIntent();
  const [start, setStart] = useState('');
  const [reserve, setReserve] = useState('');
  const [step, setStep] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [opens, setOpens] = useState('');
  const [closes, setCloses] = useState('');
  const [snipe, setSnipe] = useState('120');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const create = useMutation({
    mutationFn: (input: AuctionInput) => auctionsApi.create(input, intent.key),
    onSuccess: (a) => {
      intent.renew();
      qc.setQueryData(['auctions', a.id], a);
      void qc.invalidateQueries({ queryKey: ['me'] });
      void navigate(`/auctions/${a.id}`);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const s = start.trim() ? parseTaka(start) : null;
    const r = reserve.trim() ? parseTaka(reserve) : null;
    const inc = parseTaka(step);
    const q = Number(asciiDigits(quantity));
    const sn = Number(asciiDigits(snipe || '0'));
    const errs = {
      start:
        kind === 'FORWARD' && (s === null || s === 0)
          ? t('common.badAmount')
          : start.trim() && s === null
            ? t('common.badAmount')
            : undefined,
      reserve: reserve.trim() && r === null ? t('common.badAmount') : undefined,
      step: inc === null || inc === 0 ? t('common.badAmount') : undefined,
      quantity:
        kind === 'FORWARD' && (!Number.isInteger(q) || q < 1) ? t('common.badNumber') : undefined,
      closes: !closes
        ? t('common.required')
        : opens && closes <= opens
          ? t('common.badRange')
          : undefined,
      snipe:
        !Number.isInteger(sn) || sn < 0 || sn > 600
          ? t('common.range', { min: 0, max: 600 })
          : undefined,
    };
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) return;
    create.mutate({
      kind,
      subjectId,
      ...(kind === 'FORWARD' ? { quantity: q } : {}),
      ...(s !== null ? { startPrice: poisha(s) } : {}),
      reservePrice: r === null ? null : poisha(r),
      minIncrement: poisha(inc!),
      ...(opens ? { startsAt: new Date(opens).toISOString() } : {}),
      endsAt: new Date(closes).toISOString(),
      antiSnipeSeconds: sn,
    });
  };

  return (
    <div className="formpage">
      <header className="desk__head">
        <p className="crumb">
          <Link to={back}>{title}</Link>
        </p>
        <h1 tabIndex={-1}>{t(`auctionForm.title.${kind}`)}</h1>
        <p className="desk__lede">{t(`auctionForm.lede.${kind}`)}</p>
      </header>
      <form onSubmit={submit} noValidate>
        <section className="formsec">
          <div className="pair">
            <MoneyField
              label={t('auctionForm.startPrice')}
              optional={kind === 'REVERSE'}
              hint={kind === 'REVERSE' ? t('auctionForm.startPriceHint.REVERSE') : undefined}
              value={start}
              onChange={setStart}
              error={errors['start']}
            />
            <MoneyField
              label={t('auctionForm.step')}
              value={step}
              onChange={setStep}
              error={errors['step']}
            />
          </div>
          <MoneyField
            label={t('auctionForm.reserve')}
            optional
            hint={t('auctionForm.reserveHint')}
            value={reserve}
            onChange={setReserve}
            error={errors['reserve']}
          />
          {kind === 'FORWARD' && (
            <TextField
              label={t('auctionForm.quantity')}
              inputMode="numeric"
              value={quantity}
              onChange={setQuantity}
              error={errors['quantity']}
            />
          )}
          <div className="pair">
            <TextField
              type="datetime-local"
              label={t('auctionForm.startsAt')}
              optional
              hint={t('auctionForm.startsAtHint')}
              value={opens}
              onChange={setOpens}
            />
            <TextField
              type="datetime-local"
              label={t('auctionForm.endsAt')}
              hint={t('auctionForm.endsAtHint')}
              value={closes}
              onChange={setCloses}
              error={errors['closes']}
            />
          </div>
          <TextField
            label={t('auctionForm.antiSnipe')}
            inputMode="numeric"
            value={snipe}
            onChange={setSnipe}
            error={errors['snipe']}
          />
          {create.isError && (
            <p className="alert" role="alert">
              <AlertIcon />
              <span>{errorMessage(create.error, t)}</span>
            </p>
          )}
          <div className="formactions">
            <button type="submit" className="btn" disabled={create.isPending}>
              {t('auctionForm.start')}
            </button>
          </div>
        </section>
      </form>
    </div>
  );
}
