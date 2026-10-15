import { useState } from 'react';
import { Link } from 'react-router';
import { Segmented } from '../components/forms/fields';
import { KeyGlyph } from '../components/glyphs/glyphs';
import { MoreButton, usePaged } from '../components/ui/Paging';
import { LedgerSkeleton, LoadError, SignedInOnly } from '../components/ui/Status';
import { useSession } from '../features/auth/session';
import { bookingCode, rentalsApi } from '../features/rentals/api';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';

export default function BookingsRoute() {
  return (
    <SignedInOnly from="/bookings">
      <Bookings />
    </SignedInOnly>
  );
}

function Bookings() {
  const { t, date } = useI18n();
  const f = useFormat();
  const me = useSession().account?.id;
  const [role, setRole] = useState<'' | 'renter' | 'owner'>('');
  const list = usePaged(['me', 'bookings', role], (cursor) =>
    rentalsApi.mine({ role: role || undefined }, cursor),
  );
  return (
    <div className="browse">
      <header className="desk__head">
        <p className="crumb">
          <Link to="/dashboard">{t('nav.dashboard')}</Link>
        </p>
        <h1 tabIndex={-1}>{t('bookings.title')}</h1>
        <p className="desk__lede">{t('bookings.lede')}</p>
      </header>
      <section aria-labelledby="bookings-list">
        <div className="section-head">
          <h2 id="bookings-list">{t('dash.bookings')}</h2>
        </div>
        <Segmented
          legend={t('bookings.role')}
          hideLegend
          name="booking-role"
          value={role}
          onChange={setRole}
          options={[
            { value: '', label: t('bookings.role.all') },
            { value: 'renter', label: t('bookings.role.renter') },
            { value: 'owner', label: t('bookings.role.owner') },
          ]}
        />
        {list.isPending && <LedgerSkeleton rows={3} />}
        {list.isError && <LoadError onRetry={() => void list.refetch()} />}
        {list.data && list.rows.length === 0 && <p className="muted">{t('bookings.empty')}</p>}
        {list.rows.length > 0 && (
          <ul className="ledger">
            {list.rows.map((b) => {
              const title =
                typeof b.terms['listingTitle'] === 'string' ? b.terms['listingTitle'] : null;
              return (
                <li key={b.id}>
                  <span className="ledger__art">
                    <KeyGlyph />
                  </span>
                  <div>
                    <Link className="ledger__title" to={`/bookings/${b.id}`}>
                      {title ?? t('booking.code', { code: bookingCode(b.id) })}
                    </Link>
                    <p className="ledger__meta">
                      {[
                        bookingCode(b.id),
                        t(`booking.as.${b.renterId === me ? 'RENTER' : 'OWNER'}`),
                        t('dash.period', {
                          from: date(b.startAt, 'short'),
                          to: date(b.endAt, 'short'),
                        }),
                        f.taka(b.amount),
                        f.state(b.status),
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
