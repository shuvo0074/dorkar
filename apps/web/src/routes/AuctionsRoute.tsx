import { Link, useSearchParams } from 'react-router';
import { Segmented } from '../components/forms/fields';
import { GavelGlyph } from '../components/glyphs/glyphs';
import { MoreButton, usePaged } from '../components/ui/Paging';
import { LedgerSkeleton, LoadError } from '../components/ui/Status';
import { useSession } from '../features/auth/session';
import { auctionCode, auctionsApi, type Auction, type AuctionKind } from '../features/auctions/api';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';

export function AuctionEntry({ a }: { a: Auction }) {
  const { t } = useI18n();
  const f = useFormat();
  const price = a.leadingAmount ?? a.startPrice;
  return (
    <li className="entry">
      <Link to={`/auctions/${a.id}`} className="entry__link">
        <div className="entry__art">
          <GavelGlyph />
        </div>
        <span className="entry__code code">{auctionCode(a.id)}</span>
        <span className="entry__title">{a.title}</span>
        <span className="entry__meta">
          {[
            t(`auctions.kind.${a.kind}`),
            f.taka(price),
            a.status === 'OPEN' && t('auction.endsIn', { when: f.relative(a.endsAt) }),
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </Link>
    </li>
  );
}

export default function AuctionsRoute() {
  const { t, num } = useI18n();
  const { status } = useSession();
  const [params, setParams] = useSearchParams();
  const kindParam = params.get('kind');
  const kind: AuctionKind | '' =
    kindParam === 'FORWARD' || kindParam === 'REVERSE' ? kindParam : '';
  const list = usePaged(['auctions', kind], (cursor) =>
    auctionsApi.list({ kind: kind || undefined, status: 'OPEN' }, cursor),
  );

  return (
    <div className="browse">
      <header className="desk__head">
        <h1 tabIndex={-1}>{t('auctions.title')}</h1>
        <p className="desk__lede">{t('auctions.lede')}</p>
        {status === 'signedIn' && (
          <div className="desk__meta">
            <Link className="btn btn--outline btn--small" to="/my/auctions">
              {t('auctions.yours')}
            </Link>
          </div>
        )}
      </header>
      <section aria-labelledby="auction-results" aria-busy={list.isFetching}>
        <div className="section-head">
          <h2 id="auction-results">{t('auctions.title')}</h2>
          {list.data && <p>{t('feed.count', { n: num(list.rows.length) })}</p>}
        </div>
        <Segmented
          legend={t('auctions.kind')}
          hideLegend
          name="auction-kind"
          value={kind}
          onChange={(k) => setParams(k ? { kind: k } : {})}
          options={[
            { value: '' as const, label: t('auctions.kind.all') },
            { value: 'FORWARD' as const, label: t('auctions.kind.FORWARD') },
            { value: 'REVERSE' as const, label: t('auctions.kind.REVERSE') },
          ]}
        />
        {list.isPending && <LedgerSkeleton rows={4} />}
        {list.isError && <LoadError onRetry={() => void list.refetch()} />}
        {list.data && list.rows.length === 0 && <p className="muted">{t('auctions.empty')}</p>}
        {list.rows.length > 0 && (
          <ul className="catalog">
            {list.rows.map((a) => (
              <AuctionEntry key={a.id} a={a} />
            ))}
          </ul>
        )}
        <MoreButton query={list} />
      </section>
    </div>
  );
}
