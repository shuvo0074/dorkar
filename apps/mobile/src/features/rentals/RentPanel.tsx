import { findContactInfo } from '@dorkar/contracts';
import { rentalsApi } from '@web/features/rentals/api';
import type { Listing } from '@web/features/catalog/api';
import { useFormat } from '@web/lib/format';
import { ApiError } from '@web/lib/http';
import { useIntent } from '@web/lib/useIntent';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { c } from '../../design/tokens';
import { errorMessage } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { useNav } from '../../nav/routes';
import { Button } from '../../ui/Button';
import { DateField, TextAreaField } from '../../ui/Fields';
import { Alert, Stack } from '../../ui/Layout';
import { T } from '../../ui/Text';

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
  const nav = useNav();
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
      nav.navigate('Booking', { id: b.id });
    },
  });

  const submit = () => {
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
    <Stack>
      {lines.length > 0 ? (
        <Stack gap={4}>
          {lines.map((l) => (
            <T key={l} v="small" color={c.inkSoft}>
              {l}
            </T>
          ))}
        </Stack>
      ) : null}
      <Stack gap={4}>
        <T v="label" color={c.inkSoft}>
          {t('rent.calendar')}
        </T>
        {busy.data ? (
          busy.data.busy.length === 0 ? (
            <T color={c.inkSoft}>{t('rent.busyNone')}</T>
          ) : (
            busy.data.busy.map((b) => (
              <T key={b.startAt} v="small">
                {t('dash.period', { from: date(b.startAt), to: date(b.endAt) })}
              </T>
            ))
          )
        ) : null}
      </Stack>
      <DateField
        mode="datetime"
        label={t('rent.from')}
        value={from}
        onChange={setFrom}
        error={errors['from']}
      />
      <DateField
        mode="datetime"
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
        error={errors['note']}
      />
      <Button
        block
        busy={book.isPending}
        disabled={terms.isPending}
        label={terms.data?.instantBook ? t('rent.book') : t('rent.request')}
        onPress={submit}
      />
      {book.isError ? (
        <Alert message={overlap ? t('rent.overlap') : errorMessage(book.error, t)} />
      ) : null}
    </Stack>
  );
}
