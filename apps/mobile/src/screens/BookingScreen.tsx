import { catalogApi } from '@web/features/catalog/api';
import { dealCode } from '@web/features/deals/api';
import {
  bookingCode,
  rentalsApi,
  type BookingAction,
  type BookingDetail,
} from '@web/features/rentals/api';
import { useFormat } from '@web/lib/format';
import { ApiError } from '@web/lib/http';
import { useIntent } from '@web/lib/useIntent';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { c } from '../design/tokens';
import { useSession } from '../features/auth/session';
import {
  NotFound,
  PageError,
  PageSkeleton,
  TimelineRow,
  useRefresh,
} from '../features/catalog/pageParts';
import { UserLink } from '../features/trust/UserLink';
import { errorMessage } from '../lib/errors';
import { useI18n } from '../lib/i18n';
import { SignedInOnly } from '../nav/SignedInOnly';
import { useNav, useParams } from '../nav/routes';
import { Button, LinkText } from '../ui/Button';
import { TextAreaField } from '../ui/Fields';
import { Alert, Card, Divider, PageTitle, Row, Screen, Section, Stack } from '../ui/Layout';
import { Badge, Fact } from '../ui/Misc';
import { T } from '../ui/Text';

export default function BookingScreen() {
  const { id } = useParams<'Booking'>()!;
  return (
    <SignedInOnly>
      <Loader id={id} />
    </SignedInOnly>
  );
}

function Loader({ id }: { id: string }) {
  const b = useQuery({ queryKey: ['bookings', id], queryFn: () => rentalsApi.get(id) });
  const pull = useRefresh(() => b.refetch());
  if (b.isPending) return <PageSkeleton />;
  if (b.error instanceof ApiError && b.error.status === 404) return <NotFound />;
  if (b.isError) return <PageError onRetry={() => void b.refetch()} />;
  return (
    <Screen {...pull}>
      <BookingPage b={b.data} />
    </Screen>
  );
}

function BookingPage({ b }: { b: BookingDetail }) {
  const { t, date } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const me = useSession().account?.id;
  const listing = useQuery({
    queryKey: ['listings', b.listingId],
    queryFn: () => catalogApi.listing(b.listingId),
  });
  const title =
    (typeof b.terms['listingTitle'] === 'string' ? b.terms['listingTitle'] : null) ??
    listing.data?.title ??
    t('booking.code', { code: bookingCode(b.id) });

  return (
    <>
      <Stack>
        <Row>
          <T v="code" color={c.inkSoft}>
            {t('booking.code', { code: bookingCode(b.id) })}
          </T>
          <Badge label={f.state(b.status)} />
          {b.viewerRole ? (
            <T v="small" color={c.inkSoft}>
              {t(`booking.as.${b.viewerRole}`)}
            </T>
          ) : null}
        </Row>
        <PageTitle>{title}</PageTitle>
        <T color={c.inkSoft}>
          {t('dash.period', { from: date(b.startAt), to: date(b.endAt) })} · {f.taka(b.amount)}
        </T>
        {b.status === 'HELD' && b.holdExpiresAt ? (
          <Alert tone="info" message={t('booking.hold', { when: date(b.holdExpiresAt) })} />
        ) : null}
      </Stack>

      <Section title={t('need.details')}>
        <Card>
          <Fact label={t('booking.listing')}>
            <LinkText
              label={listing.data?.title ?? t('chat.open')}
              onPress={() => nav.navigate('Listing', { id: b.listingId })}
            />
          </Fact>
          {b.viewerRole ? (
            <Fact label={t('deal.otherSide')}>
              <UserLink userId={b.viewerRole === 'RENTER' ? b.ownerId : b.renterId} />
            </Fact>
          ) : null}
          <Fact label={t('booking.period')}>
            {t('dash.period', { from: date(b.startAt), to: date(b.endAt) })}
          </Fact>
          <Fact label={t('booking.amount')}>{f.taka(b.amount)}</Fact>
          {b.deposit ? <Fact label={t('booking.deposit')}>{f.taka(b.deposit)}</Fact> : null}
          {b.note ? <Fact label={t('booking.note')}>{b.note}</Fact> : null}
          {b.declineReason ? <Fact label={t('booking.declined')}>{b.declineReason}</Fact> : null}
          {b.cancelReason ? <Fact label={t('booking.cancelled')}>{b.cancelReason}</Fact> : null}
          {b.transactionId ? (
            <Fact label={t('booking.deal')}>
              <LinkText
                label={dealCode(b.transactionId)}
                onPress={() => nav.navigate('Deal', { id: b.transactionId! })}
              />
            </Fact>
          ) : null}
        </Card>
      </Section>

      <Card>
        <Actions b={b} />
      </Card>

      <Section title={t('booking.timeline')}>
        <Stack gap={0}>
          {[...b.transitions].reverse().map((tr, i) => (
            <Stack key={i} gap={0}>
              {i > 0 ? <Divider /> : null}
              <TimelineRow
                at={date(tr.at)}
                line={`${f.state(tr.from)} → ${f.state(tr.to)}`}
                sub={`${tr.actorId === me ? t('deal.byYou') : tr.actorRole.toLowerCase()}${
                  tr.reason ? ` · “${tr.reason}”` : ''
                }`}
              />
            </Stack>
          ))}
        </Stack>
      </Section>
    </>
  );
}

function Actions({ b }: { b: BookingDetail }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const intent = useIntent();
  const [asking, setAsking] = useState<'decline' | 'cancel' | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const run = useMutation({
    mutationFn: ({ action, reason: r }: { action: BookingAction; reason?: string }) =>
      rentalsApi.act(b.id, action, r ? { reason: r } : {}, intent.key),
    onSuccess: (next) => {
      intent.renew();
      setAsking(null);
      setReason('');
      qc.setQueryData(['bookings', b.id], next);
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });

  if (b.actions.length === 0) return <T color={c.inkSoft}>{t('deal.noActions')}</T>;

  const submit = () => {
    if (!asking) return;
    const r = reason.trim();
    if (asking === 'decline' && r.length < 3) return setError(t('common.required'));
    if (r && r.length < 3) return setError(t('common.required'));
    setError(undefined);
    run.mutate({ action: asking, ...(r ? { reason: r } : {}) });
  };

  return (
    <Stack>
      {asking === null ? (
        <>
          {b.actions.includes('confirm') ? (
            <Button
              block
              disabled={run.isPending}
              label={t('booking.cmd.confirm')}
              onPress={() => run.mutate({ action: 'confirm' })}
            />
          ) : null}
          {b.actions.includes('approve') ? (
            <Button
              block
              disabled={run.isPending}
              label={t('booking.cmd.approve')}
              onPress={() => run.mutate({ action: 'approve' })}
            />
          ) : null}
          {b.actions.includes('decline') ? (
            <Button
              kind="danger"
              small
              label={t('booking.cmd.decline')}
              onPress={() => setAsking('decline')}
            />
          ) : null}
          {b.actions.includes('cancel') ? (
            <Button
              kind="danger"
              small
              label={t('booking.cmd.cancel')}
              onPress={() => setAsking('cancel')}
            />
          ) : null}
        </>
      ) : (
        <>
          <TextAreaField
            label={t('booking.reason')}
            optional={asking === 'cancel'}
            value={reason}
            onChange={setReason}
            maxLength={500}
            error={error}
          />
          <Row>
            <Button
              kind="danger"
              small
              busy={run.isPending}
              label={t(asking === 'decline' ? 'booking.confirmDecline' : 'booking.confirmCancel')}
              onPress={submit}
            />
            <Button kind="outline" small label={t('common.keep')} onPress={() => setAsking(null)} />
          </Row>
        </>
      )}
      {run.isError ? <Alert message={errorMessage(run.error, t)} /> : null}
    </Stack>
  );
}
