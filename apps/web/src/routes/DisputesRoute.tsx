import { Link } from 'react-router';
import { ScalesGlyph } from '../components/glyphs/glyphs';
import { MoreButton, usePaged } from '../components/ui/Paging';
import { LedgerSkeleton, LoadError, SignedInOnly } from '../components/ui/Status';
import { dealCode } from '../features/deals/api';
import { disputesApi } from '../features/disputes/api';
import { shortCode, useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';

export default function DisputesRoute() {
  return (
    <SignedInOnly from="/disputes">
      <MyDisputes />
    </SignedInOnly>
  );
}

function MyDisputes() {
  const { t } = useI18n();
  const f = useFormat();
  const list = usePaged(['me', 'disputes'], (cursor) => disputesApi.mine(undefined, cursor));
  return (
    <div className="browse">
      <header className="desk__head">
        <p className="crumb">
          <Link to="/dashboard">{t('nav.dashboard')}</Link>
        </p>
        <h1 tabIndex={-1}>{t('disputes.title')}</h1>
        <p className="desk__lede">{t('disputes.lede')}</p>
      </header>
      <section aria-labelledby="disputes-list">
        <div className="section-head">
          <h2 id="disputes-list">{t('dash.disputes')}</h2>
        </div>
        {list.isPending && <LedgerSkeleton rows={3} />}
        {list.isError && <LoadError onRetry={() => void list.refetch()} />}
        {list.data && list.rows.length === 0 && <p className="muted">{t('disputes.empty')}</p>}
        {list.rows.length > 0 && (
          <ul className="ledger">
            {list.rows.map((d) => (
              <li key={d.id}>
                <span className="ledger__art">
                  <ScalesGlyph />
                </span>
                <div>
                  <Link className="ledger__title" to={`/disputes/${d.id}`}>
                    {t(`reason.${d.reason}`)}
                  </Link>
                  <p className="ledger__meta">
                    {[
                      shortCode('D', d.id),
                      t('dispute.onDeal', { code: dealCode(d.transactionId) }),
                      f.state(d.status),
                      f.relative(d.updatedAt),
                    ].join(' · ')}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
        <MoreButton query={list} />
      </section>
    </div>
  );
}
