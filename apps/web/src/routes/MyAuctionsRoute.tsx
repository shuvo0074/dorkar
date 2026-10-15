import { Link } from 'react-router';
import { GavelGlyph } from '../components/glyphs/glyphs';
import { MoreButton, usePaged } from '../components/ui/Paging';
import { LedgerSkeleton, LoadError, SignedInOnly } from '../components/ui/Status';
import { auctionCode, auctionsApi } from '../features/auctions/api';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';

export default function MyAuctionsRoute() {
  return (
    <SignedInOnly from="/my/auctions">
      <div className="browse">
        <Head />
        <Running />
        <MyBids />
      </div>
    </SignedInOnly>
  );
}

function Head() {
  const { t } = useI18n();
  return (
    <header className="desk__head">
      <p className="crumb">
        <Link to="/auctions">{t('auctions.title')}</Link>
      </p>
      <h1 tabIndex={-1}>{t('myAuctions.title')}</h1>
    </header>
  );
}

function Running() {
  const { t } = useI18n();
  const f = useFormat();
  const list = usePaged(['me', 'auctions'], (cursor) => auctionsApi.mine(cursor));
  return (
    <section aria-labelledby="running-title">
      <div className="section-head">
        <h2 id="running-title">{t('myAuctions.running')}</h2>
      </div>
      {list.isPending && <LedgerSkeleton rows={2} />}
      {list.isError && <LoadError onRetry={() => void list.refetch()} />}
      {list.data && list.rows.length === 0 && <p className="muted">{t('myAuctions.empty')}</p>}
      {list.rows.length > 0 && (
        <ul className="ledger">
          {list.rows.map((a) => (
            <li key={a.id}>
              <span className="ledger__art">
                <GavelGlyph />
              </span>
              <div>
                <Link className="ledger__title" to={`/auctions/${a.id}`}>
                  {a.title}
                </Link>
                <p className="ledger__meta">
                  {[
                    auctionCode(a.id),
                    t(`auctions.kind.${a.kind}`),
                    f.state(a.status),
                    a.leadingAmount ? f.taka(a.leadingAmount) : t('auction.noBids'),
                  ].join(' · ')}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <MoreButton query={list} />
    </section>
  );
}

function MyBids() {
  const { t } = useI18n();
  const f = useFormat();
  const list = usePaged(['me', 'bids'], (cursor) => auctionsApi.myBids(cursor));
  return (
    <section aria-labelledby="bids-title">
      <div className="section-head">
        <h2 id="bids-title">{t('myAuctions.bids')}</h2>
      </div>
      {list.isPending && <LedgerSkeleton rows={2} />}
      {list.isError && <LoadError onRetry={() => void list.refetch()} />}
      {list.data && list.rows.length === 0 && <p className="muted">{t('myAuctions.noBids')}</p>}
      {list.rows.length > 0 && (
        <ul className="ledger">
          {list.rows.map((b) => (
            <li key={b.id}>
              <span className="ledger__art code">{t(`bid.${b.status}`)}</span>
              <div>
                <Link className="ledger__title" to={`/auctions/${b.auction.id}`}>
                  {b.auction.title}
                </Link>
                <p className="ledger__meta">
                  {[
                    f.taka(b.amount),
                    f.state(b.auction.status),
                    b.auction.leadingAmount &&
                      `${t('auction.leading')} ${f.taka(b.auction.leadingAmount)}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <MoreButton query={list} />
    </section>
  );
}
