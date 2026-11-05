import { auctionCode, auctionsApi, type AuctionDetail } from '@web/features/auctions/api';
import { useFormat } from '@web/lib/format';
import { ApiError } from '@web/lib/http';
import { parseTaka, poisha, takaInput } from '@web/lib/money';
import { useIntent } from '@web/lib/useIntent';
import { useIsFocused } from '@react-navigation/native';
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
import { ReportButton } from '../features/trust/ReportButton';
import { UserLink } from '../features/trust/UserLink';
import { errorMessage } from '../lib/errors';
import { useI18n } from '../lib/i18n';
import { useNav, useParams } from '../nav/routes';
import { Button, LinkText } from '../ui/Button';
import { MoneyField, TextAreaField } from '../ui/Fields';
import { Alert, Card, Divider, PageTitle, Row, Screen, Section, Stack } from '../ui/Layout';
import { Badge, Fact, MoreButton, usePaged } from '../ui/Misc';
import { T } from '../ui/Text';

const live = (s: AuctionDetail['status']) => s === 'OPEN' || s === 'CLOSING' || s === 'SCHEDULED';

export default function AuctionScreen() {
  const { id } = useParams<'Auction'>()!;
  const focused = useIsFocused();
  const a = useQuery({
    queryKey: ['auctions', id],
    queryFn: () => auctionsApi.get(id),
    // Live auctions refresh so the leading bid and the clock stay current.
    refetchInterval: (q) => (focused && q.state.data && live(q.state.data.status) ? 10_000 : false),
  });
  const qc = useQueryClient();
  const pull = useRefresh(() =>
    Promise.all([a.refetch(), qc.invalidateQueries({ queryKey: ['auctions', id, 'bids'] })]),
  );
  if (a.isPending) return <PageSkeleton />;
  if (a.error instanceof ApiError && a.error.status === 404) return <NotFound />;
  if (a.isError) return <PageError onRetry={() => void a.refetch()} />;
  return (
    <Screen {...pull}>
      <AuctionPage a={a.data} />
    </Screen>
  );
}

function AuctionPage({ a }: { a: AuctionDetail }) {
  const { t, num, date } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const session = useSession();
  const me = session.account?.id;
  const mine = me === a.ownerId;
  const openSubject = () =>
    a.subjectType === 'LISTING'
      ? nav.navigate('Listing', { id: a.subjectId })
      : nav.navigate('Need', { id: a.subjectId });

  return (
    <>
      <Stack>
        <Row>
          <T v="code" color={c.inkSoft}>
            {t('auction.code', { code: auctionCode(a.id) })}
          </T>
          <Badge tone={live(a.status) ? 'good' : 'quiet'} label={f.state(a.status)} />
          <T v="small" color={c.inkSoft}>
            {t(`auction.kind.${a.kind}`)}
          </T>
        </Row>
        <PageTitle>{a.title}</PageTitle>
        <T color={c.inkSoft}>
          {a.status === 'SCHEDULED'
            ? t('auction.startsIn', { when: f.relative(a.startsAt) })
            : live(a.status)
            ? t('auction.endsIn', { when: f.relative(a.endsAt) })
            : t('auction.ended', { when: date(a.closedAt ?? a.endsAt) })}
          {' · '}
          {t('auction.bids', { n: a.bidCount })}
        </T>
        {a.winnerId && a.winnerId === me ? (
          <Stack gap={4}>
            <Alert tone="info" message={t('auction.won')} />
            <LinkText label={t('nav.deals')} onPress={() => nav.navigate('Deals')} />
          </Stack>
        ) : null}
        {a.cancelReason ? (
          <Alert tone="info" message={t('auction.cancelled', { reason: a.cancelReason })} />
        ) : null}
      </Stack>

      <Section title={t('need.details')}>
        <Card>
          <Fact label={t(`auction.subject.${a.subjectType}`)}>
            <LinkText label={a.title} onPress={openSubject} />
          </Fact>
          {!mine ? (
            <Fact label={t('listing.seller')}>
              <UserLink userId={a.ownerId} />
            </Fact>
          ) : null}
          <Fact label={t('auction.start')}>{f.taka(a.startPrice)}</Fact>
          <Fact label={t('auction.step')}>{f.taka(a.minIncrement)}</Fact>
          <Fact label={t('auction.quantity')}>{num(a.quantity)}</Fact>
          <Fact label={t('auction.place')}>{f.district(a.district)}</Fact>
          <Fact label={t('auction.reserve')}>
            {`${a.reservePrice ? `${f.taka(a.reservePrice)} · ` : ''}${
              a.reserveMet ? t('auction.reserveMet') : t('auction.reserveNotMet')
            }`}
          </Fact>
          {a.winnerId && a.winnerId !== me ? (
            <Fact label={t('state.AWARDED')}>
              <UserLink userId={a.winnerId} />
            </Fact>
          ) : null}
        </Card>
        {a.antiSnipeSeconds > 0 && live(a.status) ? (
          <T color={c.inkSoft}>{t('auction.antiSnipe', { n: a.antiSnipeSeconds })}</T>
        ) : null}
      </Section>

      <Stack>
        <Card>
          <T v="label" color={c.inkSoft}>
            {t('auction.leading')}
          </T>
          <T v="price">{a.leadingAmount ? f.taka(a.leadingAmount) : t('auction.noBids')}</T>
          {a.myBid ? (
            <T v="code">
              {t('auction.yourBid', {
                amount: f.taka(a.myBid.amount),
                state: t(`bid.${a.myBid.status}`),
              })}
            </T>
          ) : null}
          {session.status !== 'signedIn' ? (
            live(a.status) ? (
              <Button
                block
                label={t('auction.signIn')}
                onPress={() =>
                  nav.navigate('SignIn', { from: { name: 'Auction', params: { id: a.id } } })
                }
              />
            ) : null
          ) : (
            <Actions a={a} />
          )}
          {live(a.status) ? (
            <T v="small" color={c.inkSoft}>
              {t('auction.live')}
            </T>
          ) : null}
        </Card>
        {!mine ? <ReportButton targetType="AUCTION" targetId={a.id} /> : null}
      </Stack>

      <Bids id={a.id} />
    </>
  );
}

function Actions({ a }: { a: AuctionDetail }) {
  const { t } = useI18n();
  const f = useFormat();
  const qc = useQueryClient();
  const intent = useIntent();
  const [amount, setAmount] = useState(a.nextBid ? takaInput(a.nextBid.minimum) : '');
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const refresh = (next: AuctionDetail) => {
    intent.renew();
    qc.setQueryData(['auctions', a.id], next);
    void qc.invalidateQueries({ queryKey: ['auctions', a.id, 'bids'] });
    void qc.invalidateQueries({ queryKey: ['me'] });
  };
  const bid = useMutation({
    mutationFn: (p: number) => auctionsApi.bid(a.id, poisha(p), intent.key),
    onSuccess: (r) => refresh(r.auction),
  });
  const retract = useMutation({
    mutationFn: () => auctionsApi.retract(a.id, a.myBid!.id, intent.key),
    onSuccess: (r) => refresh(r.auction),
  });
  const cancel = useMutation({
    mutationFn: () => auctionsApi.cancel(a.id, reason.trim() || undefined, intent.key),
    onSuccess: (next) => {
      setCancelling(false);
      refresh(next);
    },
  });

  const n = a.nextBid;
  const hint = n
    ? n.maximum && a.kind === 'FORWARD'
      ? t('auction.bidHint.range', { min: f.taka(n.minimum), max: f.taka(n.maximum) })
      : a.kind === 'FORWARD'
      ? t('auction.bidHint.FORWARD', { min: f.taka(n.minimum) })
      : t('auction.bidHint.REVERSE', { max: f.taka(n.maximum ?? n.minimum) })
    : undefined;

  const submit = () => {
    const p = parseTaka(amount);
    if (p === null || p === 0) return setError(t('common.badAmount'));
    setError(undefined);
    bid.mutate(p);
  };

  const problem = bid.error ?? retract.error ?? cancel.error;
  return (
    <Stack>
      {a.actions.includes('BID') ? (
        <Stack>
          <MoneyField
            label={t('auction.bidLabel')}
            hint={hint}
            value={amount}
            onChange={setAmount}
            error={error}
          />
          <Button block busy={bid.isPending} label={t('auction.placeBid')} onPress={submit} />
          {bid.isSuccess ? <T color={c.inkSoft}>{t('auction.placed')}</T> : null}
        </Stack>
      ) : !a.actions.length ? (
        <T color={c.inkSoft}>{t('auction.notOpen')}</T>
      ) : null}
      {a.actions.includes('RETRACT_BID') && a.myBid ? (
        <Stack gap={6}>
          <Button
            kind="outline"
            small
            busy={retract.isPending}
            label={t('auction.retract')}
            onPress={() => retract.mutate()}
          />
          <T v="small" color={c.inkSoft}>
            {t('auction.retractHelp')}
          </T>
        </Stack>
      ) : null}
      {a.actions.includes('CANCEL') ? (
        cancelling ? (
          <Stack>
            <TextAreaField
              label={t('auction.cancelReason')}
              optional
              value={reason}
              onChange={setReason}
              maxLength={500}
            />
            <Row>
              <Button
                kind="danger"
                small
                busy={cancel.isPending}
                label={t('auction.cancelYes')}
                onPress={() => cancel.mutate()}
              />
              <Button
                kind="outline"
                small
                label={t('common.keep')}
                onPress={() => setCancelling(false)}
              />
            </Row>
          </Stack>
        ) : (
          <Button
            kind="danger"
            small
            label={t('auction.cancel')}
            onPress={() => setCancelling(true)}
          />
        )
      ) : null}
      {problem ? <Alert message={errorMessage(problem, t)} /> : null}
    </Stack>
  );
}

function Bids({ id }: { id: string }) {
  const { t, date } = useI18n();
  const f = useFormat();
  const focused = useIsFocused();
  const list = usePaged(['auctions', id, 'bids'], (cursor) => auctionsApi.bids(id, cursor), {
    ...(focused ? { refetchInterval: 15_000 } : {}),
  });
  return (
    <Section title={t('auction.history')}>
      {list.data && list.rows.length === 0 ? <T color={c.inkSoft}>{t('auction.noBids')}</T> : null}
      {list.rows.length > 0 ? (
        <Stack gap={0}>
          {list.rows.map((b, i) => (
            <Stack key={b.id} gap={0}>
              {i > 0 ? <Divider /> : null}
              <TimelineRow
                at={date(b.placedAt)}
                line={`${f.taka(b.amount)} · ${b.bidder}${
                  b.isMine ? ` (${t('auction.mine')})` : ''
                }`}
                sub={t(`bid.${b.status}`)}
              />
            </Stack>
          ))}
        </Stack>
      ) : null}
      <MoreButton query={list} />
    </Section>
  );
}
