import { useState } from 'react';
import { Link } from 'react-router';
import { Segmented } from '../components/forms/fields';
import { CrateGlyph } from '../components/glyphs/glyphs';
import { MoreButton, usePaged } from '../components/ui/Paging';
import { LedgerSkeleton, LoadError, SignedInOnly } from '../components/ui/Status';
import { useSession } from '../features/auth/session';
import { itemCode, lendingApi, loanCode } from '../features/lending/api';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';

export default function LoansRoute() {
  return (
    <SignedInOnly from="/loans">
      <div className="browse">
        <Head />
        <Loans />
        <Items />
      </div>
    </SignedInOnly>
  );
}

function Head() {
  const { t } = useI18n();
  return (
    <header className="desk__head">
      <p className="crumb">
        <Link to="/dashboard">{t('nav.dashboard')}</Link>
      </p>
      <h1 tabIndex={-1}>{t('loans.title')}</h1>
      <p className="desk__lede">{t('loans.lede')}</p>
      <div className="desk__meta">
        <Link className="btn btn--small" to="/lend/new">
          {t('lend.lendYours')}
        </Link>
      </div>
    </header>
  );
}

function Loans() {
  const { t, date } = useI18n();
  const f = useFormat();
  const me = useSession().account?.id;
  const [role, setRole] = useState<'' | 'lender' | 'borrower'>('');
  const list = usePaged(['me', 'loans', role], (cursor) =>
    lendingApi.myLoans({ role: role || undefined }, cursor),
  );
  return (
    <section aria-labelledby="loans-list">
      <div className="section-head">
        <h2 id="loans-list">{t('loans.loans')}</h2>
      </div>
      <Segmented
        legend={t('bookings.role')}
        hideLegend
        name="loan-role"
        value={role}
        onChange={setRole}
        options={[
          { value: '', label: t('bookings.role.all') },
          { value: 'borrower', label: t('dash.role.BORROWER') },
          { value: 'lender', label: t('dash.role.LENDER') },
        ]}
      />
      {list.isPending && <LedgerSkeleton rows={3} />}
      {list.isError && <LoadError onRetry={() => void list.refetch()} />}
      {list.data && list.rows.length === 0 && <p className="muted">{t('loans.empty')}</p>}
      {list.rows.length > 0 && (
        <ul className="ledger">
          {list.rows.map((l) => (
            <li key={l.id}>
              <span className="ledger__art">
                <CrateGlyph />
              </span>
              <div>
                <Link className="ledger__title" to={`/loans/${l.id}`}>
                  {l.itemTitle}
                </Link>
                <p className="ledger__meta">
                  {[
                    loanCode(l.id),
                    t(`loan.as.${l.lenderId === me ? 'LENDER' : 'BORROWER'}`),
                    t('dash.returnBy', { when: date(l.returnBy, 'short') }),
                    f.state(l.status),
                    l.overdue && t('loan.overdue'),
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

function Items() {
  const { t } = useI18n();
  const f = useFormat();
  const list = usePaged(['me', 'lend-items'], (cursor) => lendingApi.myItems(cursor));
  return (
    <section aria-labelledby="items-list">
      <div className="section-head">
        <h2 id="items-list">{t('loans.items')}</h2>
      </div>
      {list.isPending && <LedgerSkeleton rows={2} />}
      {list.isError && <LoadError onRetry={() => void list.refetch()} />}
      {list.data && list.rows.length === 0 && <p className="muted">{t('loans.noItems')}</p>}
      {list.rows.length > 0 && (
        <ul className="ledger">
          {list.rows.map((i) => (
            <li key={i.id}>
              <span className="ledger__art code">{itemCode(i.id)}</span>
              <div>
                <Link className="ledger__title" to={`/lend/${i.id}`}>
                  {i.title}
                </Link>
                <p className="ledger__meta">
                  {[
                    f.district(i.district),
                    i.active ? f.state('ACTIVE') : t('lend.inactive'),
                    i.hidden && f.state('HIDDEN'),
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
