import { useState } from 'react';
import { Link } from 'react-router';
import { Segmented } from '../components/forms/fields';
import { MoreButton, usePaged } from '../components/ui/Paging';
import { LedgerSkeleton, LoadError, SignedInOnly } from '../components/ui/Status';
import { needsApi, type NeedStatus } from '../features/needs/api';
import { needCode } from '../features/needs/modes';
import { modeGlyph } from '../features/needs/NeedEntry';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';

const FILTERS = ['', 'OPEN', 'DRAFT', 'PAUSED', 'FULFILLING', 'EXPIRED', 'CLOSED'] as const;

export default function MyNeedsRoute() {
  return (
    <SignedInOnly from="/my/needs">
      <MyNeeds />
    </SignedInOnly>
  );
}

function MyNeeds() {
  const { t } = useI18n();
  const f = useFormat();
  const [status, setStatus] = useState<(typeof FILTERS)[number]>('');
  const list = usePaged(['me', 'needs', status], (cursor) =>
    needsApi.mine((status || undefined) as NeedStatus | undefined, cursor),
  );

  return (
    <div className="browse">
      <header className="desk__head">
        <p className="crumb">
          <Link to="/dashboard">{t('nav.dashboard')}</Link>
        </p>
        <h1 tabIndex={-1}>{t('myNeeds.title')}</h1>
        <p className="desk__lede">{t('myNeeds.lede')}</p>
        <div className="desk__meta">
          <Link className="btn btn--small" to="/needs/new">
            {t('myNeeds.post')}
          </Link>
        </div>
      </header>

      <section aria-labelledby="mine-title">
        <div className="section-head">
          <h2 id="mine-title">{t('feed.results')}</h2>
        </div>
        <Segmented
          legend={t('myNeeds.status')}
          hideLegend
          name="my-needs-status"
          value={status}
          onChange={setStatus}
          options={FILTERS.map((s) => ({ value: s, label: s ? f.state(s) : t('myNeeds.all') }))}
        />
        {list.isPending && <LedgerSkeleton rows={4} />}
        {list.isError && <LoadError onRetry={() => void list.refetch()} />}
        {list.data && list.rows.length === 0 && (
          <p className="muted">{t(status ? 'myNeeds.emptyStatus' : 'myNeeds.empty')}</p>
        )}
        {list.rows.length > 0 && (
          <ul className="ledger">
            {list.rows.map((n) => {
              const Glyph = modeGlyph[n.mode];
              return (
                <li key={n.id}>
                  <span className="ledger__art">
                    <Glyph />
                  </span>
                  <div>
                    <Link className="ledger__title" to={`/needs/${n.id}`}>
                      {n.title}
                    </Link>
                    <p className="ledger__meta">
                      {[
                        needCode(n),
                        f.state(n.status),
                        t('myNeeds.offers', { n: n.offerCount }),
                        t('myNeeds.updated', { when: f.relative(n.updatedAt) }),
                      ].join(' · ')}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <MoreButton query={list} />
      </section>
    </div>
  );
}
