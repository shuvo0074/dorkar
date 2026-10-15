import { findContactInfo } from '@dorkar/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { TextAreaField, TextField } from '../../components/forms/fields';
import { AlertIcon } from '../../components/glyphs/glyphs';
import { ApiError } from '../../lib/http';
import { errorMessage } from '../../lib/errors';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { useIntent } from '../../lib/useIntent';
import type { Listing } from '../catalog/api';
import { rentalsApi } from './api';

const DAY = 86_400_000;

/** The rental's terms in one or two lines. */
export function useTermsSummary(listingId: string) {
  const { t } = useI18n();
  const f = useFormat();
  const terms = useQuery({
    queryKey: ['listings', listingId, 'rental-terms'],
    queryFn: () => rentalsApi.terms(listingId),
  });
  const d = terms.data;
  const lines = d
    ? [
        t(d.instantBook ? 'rent.instant' : 'rent.approval'),
        t('rent.minMax', { min: d.minDurationHours, max: d.maxDurationDays }),
        d.advanceNoticeHours > 0 && t('rent.notice', { n: d.advanceNoticeHours }),
        d.deposit && t('rent.deposit', { amount: f.taka(d.deposit) }),
        d.cancellationNote && t('rent.cancellation', { note: d.cancellationNote }),
      ].filter((x): x is string => Boolean(x))
    : [];
  return { terms, lines };
}

/** Pick dates against the busy calendar and request (or instantly hold) a booking. */
export function RentPanel({ listing }: { listing: Listing }) {
  const { t, date } = useI18n();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const intent = useIntent();
  const { terms, lines } = useTermsSummary(listing.id);
  const [now] = useState(() => Date.now());
  const busy = useQuery({
    queryKey: ['listings', listing.id, 'availability'],
    queryFn: () =>
      rentalsApi.availability(
        listing.id,
        new Date(now).toISOString(),
        new Date(now + 30 * DAY).toISOString(),
      ),
  });
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const book = useMutation({
    mutationFn: (input: { startAt: string; endAt: string; note?: string }) =>
      rentalsApi.book({ listingId: listing.id, ...input }, intent.key),
    onSuccess: (b) => {
      intent.renew();
      qc.setQueryData(['bookings', b.id], b);
      void qc.invalidateQueries({ queryKey: ['me'] });
      void navigate(`/bookings/${b.id}`);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const start = from ? new Date(from) : null;
    const end = until ? new Date(until) : null;
    const errs = {
      from: !start || Number.isNaN(start.getTime()) ? t('common.badDate') : undefined,
      until:
        !end || Number.isNaN(end.getTime())
          ? t('common.badDate')
          : start && end <= start
            ? t('common.badRange')
            : undefined,
      note: findContactInfo(note) ? t('needForm.contact') : undefined,
    };
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) return;
    book.mutate({
      startAt: start!.toISOString(),
      endAt: end!.toISOString(),
      ...(note.trim() ? { note: note.trim() } : {}),
    });
  };

  const overlap = book.error instanceof ApiError && book.error.status === 409;
  return (
    <form className="buy" onSubmit={submit} noValidate aria-label={t('rent.title')}>
      {lines.length > 0 && (
        <ul className="rentterms">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      <div>
        <p className="label">{t('rent.calendar')}</p>
        {busy.data &&
          (busy.data.busy.length === 0 ? (
            <p className="muted">{t('rent.busyNone')}</p>
          ) : (
            <ul className="busy">
              {busy.data.busy.map((b) => (
                <li key={b.startAt}>
                  {t('dash.period', { from: date(b.startAt), to: date(b.endAt) })}
                </li>
              ))}
            </ul>
          ))}
      </div>
      <TextField
        type="datetime-local"
        label={t('rent.from')}
        value={from}
        onChange={setFrom}
        error={errors['from']}
      />
      <TextField
        type="datetime-local"
        label={t('rent.until')}
        value={until}
        onChange={setUntil}
        error={errors['until']}
      />
      <TextAreaField
        label={t('rent.note')}
        optional
        value={note}
        onChange={setNote}
        maxLength={500}
        rows={2}
        error={errors['note']}
      />
      <button type="submit" className="btn btn--block" disabled={book.isPending || terms.isPending}>
        {terms.data?.instantBook ? t('rent.book') : t('rent.request')}
      </button>
      {book.isError && (
        <p className="alert" role="alert">
          <AlertIcon />
          <span>{overlap ? t('rent.overlap') : errorMessage(book.error, t)}</span>
        </p>
      )}
    </form>
  );
}
