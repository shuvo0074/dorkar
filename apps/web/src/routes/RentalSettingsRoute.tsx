import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { CheckField, MoneyField, TextAreaField, TextField } from '../components/forms/fields';
import { AlertIcon, NoteIcon } from '../components/glyphs/glyphs';
import { LedgerSkeleton, LoadError, SignedInOnly } from '../components/ui/Status';
import { catalogApi } from '../features/catalog/api';
import { rentalsApi, type RentalTerms } from '../features/rentals/api';
import { errorMessage } from '../lib/errors';
import { useI18n } from '../lib/i18n';
import { asciiDigits, parseTaka, poisha, takaInput } from '../lib/money';
import { useIntent } from '../lib/useIntent';

export default function RentalSettingsRoute() {
  const { id = '' } = useParams();
  return (
    <SignedInOnly from={`/listings/${id}/rental`}>
      <Loader id={id} />
    </SignedInOnly>
  );
}

function Loader({ id }: { id: string }) {
  const { t } = useI18n();
  const listing = useQuery({ queryKey: ['listings', id], queryFn: () => catalogApi.listing(id) });
  const terms = useQuery({
    queryKey: ['listings', id, 'rental-terms'],
    queryFn: () => rentalsApi.terms(id),
  });
  if (listing.isPending || terms.isPending) return <LedgerSkeleton rows={6} />;
  if (listing.isError) return <LoadError onRetry={() => void listing.refetch()} />;
  if (terms.isError) return <LoadError onRetry={() => void terms.refetch()} />;
  return (
    <div className="formpage">
      <header className="desk__head">
        <p className="crumb">
          <Link to={`/listings/${id}`}>{listing.data.title}</Link>
        </p>
        <h1 tabIndex={-1}>{t('rterms.title')}</h1>
        <p className="desk__lede">{t('rterms.lede')}</p>
      </header>
      <TermsForm listingId={id} initial={terms.data} />
      <Blocks listingId={id} />
    </div>
  );
}

const int = (v: string) => Number(asciiDigits(v.trim()));

function TermsForm({ listingId, initial }: { listingId: string; initial: RentalTerms }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [instant, setInstant] = useState(initial.instantBook);
  const [minH, setMinH] = useState(String(initial.minDurationHours));
  const [maxD, setMaxD] = useState(String(initial.maxDurationDays));
  const [deposit, setDeposit] = useState(takaInput(initial.deposit));
  const [notice, setNotice] = useState(String(initial.advanceNoticeHours));
  const [buffer, setBuffer] = useState(String(initial.bufferHours));
  const [note, setNote] = useState(initial.cancellationNote ?? '');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const save = useMutation({
    mutationFn: (input: Parameters<typeof rentalsApi.saveTerms>[1]) =>
      rentalsApi.saveTerms(listingId, input),
    onSuccess: (saved) => qc.setQueryData(['listings', listingId, 'rental-terms'], saved),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const range = (v: string, lo: number, hi: number) => {
      const n = int(v);
      return Number.isInteger(n) && n >= lo && n <= hi
        ? undefined
        : t('common.range', { min: lo, max: hi });
    };
    const dep = deposit.trim() ? parseTaka(deposit) : null;
    const errs = {
      minH: range(minH, 1, 8760),
      maxD: range(maxD, 1, 365),
      notice: range(notice, 0, 720),
      buffer: range(buffer, 0, 168),
      deposit: deposit.trim() && dep === null ? t('common.badAmount') : undefined,
      note: note.trim() && note.trim().length > 500 ? t('common.tooLong', { n: 500 }) : undefined,
    };
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) return;
    save.mutate({
      instantBook: instant,
      minDurationHours: int(minH),
      maxDurationDays: int(maxD),
      deposit: dep === null ? null : poisha(dep),
      advanceNoticeHours: int(notice),
      bufferHours: int(buffer),
      cancellationNote: note.trim() || null,
    });
  };

  return (
    <form className="formsec" onSubmit={submit} noValidate>
      <CheckField label={t('rterms.instantBook')} checked={instant} onChange={setInstant} />
      <div className="pair">
        <TextField
          label={t('rterms.minHours')}
          inputMode="numeric"
          value={minH}
          onChange={setMinH}
          error={errors['minH']}
        />
        <TextField
          label={t('rterms.maxDays')}
          inputMode="numeric"
          value={maxD}
          onChange={setMaxD}
          error={errors['maxD']}
        />
      </div>
      <div className="pair">
        <TextField
          label={t('rterms.noticeHours')}
          inputMode="numeric"
          value={notice}
          onChange={setNotice}
          error={errors['notice']}
        />
        <TextField
          label={t('rterms.bufferHours')}
          inputMode="numeric"
          value={buffer}
          onChange={setBuffer}
          error={errors['buffer']}
        />
      </div>
      <MoneyField
        label={t('rterms.deposit')}
        optional
        value={deposit}
        onChange={setDeposit}
        error={errors['deposit']}
      />
      <TextAreaField
        label={t('rterms.cancellation')}
        optional
        value={note}
        onChange={setNote}
        maxLength={500}
        rows={2}
        error={errors['note']}
      />
      {save.isSuccess && (
        <p className="alert alert--note" role="status">
          <NoteIcon />
          <span>{t('rterms.saved')}</span>
        </p>
      )}
      {save.isError && (
        <p className="alert" role="alert">
          <AlertIcon />
          <span>{errorMessage(save.error, t)}</span>
        </p>
      )}
      <div className="formactions">
        <button type="submit" className="btn" disabled={save.isPending}>
          {t('rterms.save')}
        </button>
      </div>
    </form>
  );
}

function Blocks({ listingId }: { listingId: string }) {
  const { t, date } = useI18n();
  const qc = useQueryClient();
  const intent = useIntent();
  const blocks = useQuery({
    queryKey: ['listings', listingId, 'blocks'],
    queryFn: () => rentalsApi.blocks(listingId),
  });
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['listings', listingId, 'blocks'] });
    void qc.invalidateQueries({ queryKey: ['listings', listingId, 'availability'] });
  };
  const add = useMutation({
    mutationFn: (input: { startAt: string; endAt: string; reason?: string }) =>
      rentalsApi.addBlock(listingId, input, intent.key),
    onSuccess: () => {
      intent.renew();
      setFrom('');
      setUntil('');
      setReason('');
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (blockId: string) => rentalsApi.removeBlock(listingId, blockId),
    onSuccess: refresh,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!from || !until) return setError(t('common.badDate'));
    if (new Date(until) <= new Date(from)) return setError(t('common.badRange'));
    setError(undefined);
    add.mutate({
      startAt: new Date(from).toISOString(),
      endAt: new Date(until).toISOString(),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    });
  };

  return (
    <section className="formsec" aria-labelledby="blocks-title">
      <h2 id="blocks-title">{t('blocks.title')}</h2>
      <p className="muted">{t('blocks.lede')}</p>
      {blocks.data && blocks.data.length === 0 && <p className="muted">{t('blocks.none')}</p>}
      {blocks.data && blocks.data.length > 0 && (
        <ul className="statelist">
          {blocks.data.map((b) => (
            <li key={b.id}>
              <span>
                {t('dash.period', { from: date(b.startAt), to: date(b.endAt) })}
                {b.reason && <span className="muted"> · {b.reason}</span>}
              </span>
              <button type="button" className="linkbtn" onClick={() => remove.mutate(b.id)}>
                {t('blocks.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="counter" onSubmit={submit} noValidate>
        <div className="pair">
          <TextField type="datetime-local" label={t('rent.from')} value={from} onChange={setFrom} />
          <TextField
            type="datetime-local"
            label={t('rent.until')}
            value={until}
            onChange={setUntil}
          />
        </div>
        <TextField
          label={t('blocks.reason')}
          optional
          value={reason}
          onChange={setReason}
          maxLength={200}
        />
        {(error || add.isError) && (
          <p className="alert" role="alert">
            <AlertIcon />
            <span>{error ?? errorMessage(add.error, t)}</span>
          </p>
        )}
        <div className="formactions">
          <button type="submit" className="btn btn--outline btn--small" disabled={add.isPending}>
            {t('blocks.add')}
          </button>
        </div>
      </form>
    </section>
  );
}
