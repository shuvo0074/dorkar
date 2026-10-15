import { useState } from 'react';
import { Link } from 'react-router';
import { Segmented } from '../components/forms/fields';
import { MoreButton, usePaged } from '../components/ui/Paging';
import { LedgerSkeleton, LoadError, SignedInOnly } from '../components/ui/Status';
import { useSession } from '../features/auth/session';
import { dealCode, dealsApi, dealTitle, finalStates } from '../features/deals/api';
import { modeGlyph } from '../features/needs/NeedEntry';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';

export default function DealsRoute() {
  return (
    <SignedInOnly from="/deals">
      <Deals />
    </SignedInOnly>
  );
}

function Deals() {
  const { t, num } = useI18n();
  const f = useFormat();
  const me = useSession().account?.id;
  const [role, setRole] = useState<'' | 'buyer' | 'seller'>('');
  const [scope, setScope] = useState<'live' | 'all'>('live');
  const list = usePaged(['me', 'deals', role], (cursor) =>
    dealsApi.mine({ role: role || undefined }, cursor),
  );
  const rows = scope === 'live' ? list.rows.filter((d) => !finalStates.has(d.state)) : list.rows;

  return (
    <div className="browse">
      <header className="desk__head">
        <p className="crumb">
          <Link to="/dashboard">{t('nav.dashboard')}</Link>
        </p>
        <h1 tabIndex={-1}>{t('deals.title')}</h1>
        <p className="desk__lede">{t('deals.lede')}</p>
      </header>

      <section aria-labelledby="deals-title">
        <div className="section-head">
          <h2 id="deals-title">{t('nav.deals')}</h2>
        </div>
        <div className="desk__controls">
          <Segmented
            legend={t('deals.role')}
            name="deal-role"
            value={role}
            onChange={setRole}
            options={[
              { value: '', label: t('deals.role.all') },
              { value: 'buyer', label: t('deals.role.buyer') },
              { value: 'seller', label: t('deals.role.seller') },
            ]}
          />
          <Segmented
            legend={t('deals.state')}
            name="deal-scope"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'live', label: t('deals.state.live') },
              { value: 'all', label: t('deals.state.all') },
            ]}
          />
        </div>
        {list.isPending && <LedgerSkeleton rows={4} />}
        {list.isError && <LoadError onRetry={() => void list.refetch()} />}
        {list.data && rows.length === 0 && (
          <p className="muted">{t(list.rows.length ? 'deals.emptyFilter' : 'deals.empty')}</p>
        )}
        {rows.length > 0 && (
          <ul className="ledger">
            {rows.map((d) => {
              const Glyph = modeGlyph[d.mode];
              const as = d.buyerId === me ? 'BUYER' : 'SELLER';
              return (
                <li key={d.id}>
                  <span className="ledger__art">
                    <Glyph />
                  </span>
                  <div>
                    <Link className="ledger__title" to={`/deals/${d.id}`}>
                      {dealTitle(d) ?? t('deals.code', { code: dealCode(d.id) })}
                    </Link>
                    <p className="ledger__meta">
                      {[
                        dealCode(d.id),
                        t(`deals.as.${as}`),
                        `${f.taka(d.amount)}${d.quantity > 1 ? ` × ${num(d.quantity)}` : ''}`,
                        f.state(d.state),
                        f.relative(d.updatedAt),
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
