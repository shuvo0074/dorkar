import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { MoneyField, TextAreaField } from '../components/forms/fields';
import { AlertIcon, NoteIcon } from '../components/glyphs/glyphs';
import { Biro } from '../components/ui/Biro';
import { MoreButton, usePaged } from '../components/ui/Paging';
import { LedgerSkeleton, LoadError } from '../components/ui/Status';
import { useSession } from '../features/auth/session';
import { auctionCode, auctionsApi, type AuctionDetail } from '../features/auctions/api';
import { ReportButton } from '../features/trust/ReportButton';
import { UserLink } from '../features/trust/UserLink';
import { ApiError } from '../lib/http';
import { errorMessage } from '../lib/errors';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { parseTaka, poisha, takaInput } from '../lib/money';
import { useIntent } from '../lib/useIntent';
import NotFoundRoute from './NotFoundRoute';

const live = (s: AuctionDetail['status']) => s === 'OPEN' || s === 'CLOSING' || s === 'SCHEDULED';

export default function AuctionRoute() {
  const { id = '' } = useParams();
  const a = useQuery({
    queryKey: ['auctions', id],
    queryFn: () => auctionsApi.get(id),
    // Live auctions refresh so the leading bid and the clock stay current.
    refetchInterval: (q) => (q.state.data && live(q.state.data.status) ? 10_000 : false),
  });
  if (a.isPending) return <LedgerSkeleton rows={6} />;
  if (a.error instanceof ApiError && a.error.status === 404) return <NotFoundRoute />;
  if (a.isError) return <LoadError onRetry={() => void a.refetch()} />;
  return <AuctionPage a={a.data} />;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="facts__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function AuctionPage({ a }: { a: AuctionDetail }) {
  const { t, num, date } = useI18n();
  const f = useFormat();
  const session = useSession();
  const me = session.account?.id;
  const mine = me === a.ownerId;
  const subject =
    a.subjectType === 'LISTING' ? `/listings/${a.subjectId}` : `/needs/${a.subjectId}`;

  return (
    <article className="item">
      <header className="item__head">
        <p className="crumb">
          <Link to="/auctions">{t('auctions.title')}</Link>
        </p>
        <div className="item__tag">
          <span className="code">{t('auction.code', { code: auctionCode(a.id) })}</span>
          <span className={live(a.status) ? 'stamp stamp--ink' : 'stamp'}>{f.state(a.status)}</span>
          <span className="muted">{t(`auction.kind.${a.kind}`)}</span>
        </div>
        <h1 tabIndex={-1}>{a.title}</h1>
        <p className="item__meta">
          {a.status === 'SCHEDULED'
            ? t('auction.startsIn', { when: f.relative(a.startsAt) })
            : live(a.status)
              ? t('auction.endsIn', { when: f.relative(a.endsAt) })
              : t('auction.ended', { when: date(a.closedAt ?? a.endsAt) })}
          {' · '}
          {t('auction.bids', { n: a.bidCount })}
        </p>
        {a.winnerId && a.winnerId === me && (
          <p className="alert alert--note" role="status">
            <NoteIcon />
            <span>
              {t('auction.won')} <Link to="/deals">{t('nav.deals')}</Link>
            </span>
          </p>
        )}
        {a.cancelReason && (
          <p className="alert alert--note">
            <NoteIcon />
            <span>{t('auction.cancelled', { reason: a.cancelReason })}</span>
          </p>
        )}
      </header>

      <section aria-labelledby="auction-facts">
        <div className="section-head">
          <h2 id="auction-facts">{t('need.details')}</h2>
        </div>
        <dl className="facts">
          <Row label={t(`auction.subject.${a.subjectType}`)}>
            <Link to={subject}>{a.title}</Link>
          </Row>
          {!mine && (
            <Row label={t('listing.seller')}>
              <UserLink userId={a.ownerId} />
            </Row>
          )}
          <Row label={t('auction.start')}>{f.taka(a.startPrice)}</Row>
          <Row label={t('auction.step')}>{f.taka(a.minIncrement)}</Row>
          <Row label={t('auction.quantity')}>{num(a.quantity)}</Row>
          <Row label={t('auction.place')}>{f.district(a.district)}</Row>
          <Row label={t('auction.reserve')}>
            {a.reservePrice && `${f.taka(a.reservePrice)} · `}
            {a.reserveMet ? t('auction.reserveMet') : t('auction.reserveNotMet')}
          </Row>
          {a.winnerId && a.winnerId !== me && (
            <Row label={t('state.AWARDED')}>
              <UserLink userId={a.winnerId} />
            </Row>
          )}
        </dl>
        {a.antiSnipeSeconds > 0 && live(a.status) && (
          <p className="muted">{t('auction.antiSnipe', { n: a.antiSnipeSeconds })}</p>
        )}
      </section>

      <aside className="item__side" aria-label={t('auction.leading')}>
        <div className="panel">
          <p className="label">{t('auction.leading')}</p>
          <p className="item__count">
            {a.leadingAmount ? (
              <span className="tally__mark">
                {f.taka(a.leadingAmount)}
                {a.myBid?.status === 'LEADING' && <Biro draw tilt={-3} />}
              </span>
            ) : (
              t('auction.noBids')
            )}
          </p>
          {a.myBid && (
            <p className="code">
              {t('auction.yourBid', {
                amount: f.taka(a.myBid.amount),
                state: t(`bid.${a.myBid.status}`),
              })}
            </p>
          )}
          {session.status !== 'signedIn' ? (
            live(a.status) && (
              <Link className="btn btn--block" to="/sign-in" state={{ from: `/auctions/${a.id}` }}>
                {t('auction.signIn')}
              </Link>
            )
          ) : (
            <Actions a={a} />
          )}
          {live(a.status) && <p className="field__hint">{t('auction.live')}</p>}
        </div>
        {!mine && <ReportButton targetType="AUCTION" targetId={a.id} />}
      </aside>

      <Bids id={a.id} />
    </article>
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

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = parseTaka(amount);
    if (p === null || p === 0) return setError(t('common.badAmount'));
    setError(undefined);
    bid.mutate(p);
  };

  const problem = bid.error ?? retract.error ?? cancel.error;
  return (
    <div className="item__actions">
      {a.actions.includes('BID') ? (
        <form className="buy" onSubmit={submit} noValidate>
          <MoneyField
            label={t('auction.bidLabel')}
            hint={hint}
            value={amount}
            onChange={setAmount}
            error={error}
          />
          <button type="submit" className="btn btn--block" disabled={bid.isPending}>
            {t('auction.placeBid')}
          </button>
          {bid.isSuccess && (
            <p className="muted" role="status">
              {t('auction.placed')}
            </p>
          )}
        </form>
      ) : (
        !a.actions.length && <p className="muted">{t('auction.notOpen')}</p>
      )}
      {a.actions.includes('RETRACT_BID') && a.myBid && (
        <div className="dealstep">
          <button
            type="button"
            className="btn btn--outline btn--small"
            disabled={retract.isPending}
            onClick={() => retract.mutate()}
          >
            {t('auction.retract')}
          </button>
          <p className="field__hint">{t('auction.retractHelp')}</p>
        </div>
      )}
      {a.actions.includes('CANCEL') &&
        (cancelling ? (
          <form
            className="counter counter--danger"
            onSubmit={(e) => {
              e.preventDefault();
              cancel.mutate();
            }}
          >
            <TextAreaField
              label={t('auction.cancelReason')}
              optional
              value={reason}
              onChange={setReason}
              maxLength={500}
              rows={2}
            />
            <div className="formactions">
              <button
                type="submit"
                className="btn btn--danger btn--small"
                disabled={cancel.isPending}
              >
                {t('auction.cancelYes')}
              </button>
              <button
                type="button"
                className="btn btn--outline btn--small"
                onClick={() => setCancelling(false)}
              >
                {t('common.keep')}
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            className="btn btn--danger btn--small"
            onClick={() => setCancelling(true)}
          >
            {t('auction.cancel')}
          </button>
        ))}
      {problem && (
        <p className="alert" role="alert">
          <AlertIcon />
          <span>{errorMessage(problem, t)}</span>
        </p>
      )}
    </div>
  );
}

function Bids({ id }: { id: string }) {
  const { t, date } = useI18n();
  const f = useFormat();
  const list = usePaged(['auctions', id, 'bids'], (cursor) => auctionsApi.bids(id, cursor), {
    refetchInterval: 15_000,
  });
  return (
    <section className="item__wide" aria-labelledby="bids-title">
      <div className="section-head">
        <h2 id="bids-title">{t('auction.history')}</h2>
      </div>
      {list.data && list.rows.length === 0 && <p className="muted">{t('auction.noBids')}</p>}
      {list.rows.length > 0 && (
        <ol className="timeline">
          {list.rows.map((b) => (
            <li key={b.id}>
              <time className="code" dateTime={b.placedAt}>
                {date(b.placedAt)}
              </time>
              <span>
                <strong>{f.taka(b.amount)}</strong> · {b.bidder}
                {b.isMine && ` (${t('auction.mine')})`}
              </span>
              <span className="muted">{t(`bid.${b.status}`)}</span>
            </li>
          ))}
        </ol>
      )}
      <MoreButton query={list} />
    </section>
  );
}
