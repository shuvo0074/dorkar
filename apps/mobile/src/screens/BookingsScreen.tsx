import { bookingCode, rentalsApi } from '@web/features/rentals/api';
import { useFormat } from '@web/lib/format';
import { useState } from 'react';
import { c } from '../design/tokens';
import { useSession } from '../features/auth/session';
import { LedgerRow, PagedList } from '../features/catalog/pageParts';
import { useI18n } from '../lib/i18n';
import { SignedInOnly } from '../nav/SignedInOnly';
import { useNav } from '../nav/routes';
import { KeyIcon } from '../ui/icons';
import { Chips } from '../ui/Fields';
import { Stack } from '../ui/Layout';
import { usePaged } from '../ui/Misc';
import { T } from '../ui/Text';

export default function BookingsScreen() {
  return (
    <SignedInOnly>
      <Bookings />
    </SignedInOnly>
  );
}

function Bookings() {
  const { t, date } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const me = useSession().account?.id;
  const [role, setRole] = useState<'' | 'renter' | 'owner'>('');
  const list = usePaged(['me', 'bookings', role], (cursor) =>
    rentalsApi.mine({ role: role || undefined }, cursor),
  );
  return (
    <PagedList
      query={list}
      skeleton={3}
      empty={t('bookings.empty')}
      renderRow={(b) => {
        const title = typeof b.terms['listingTitle'] === 'string' ? b.terms['listingTitle'] : null;
        return (
          <LedgerRow
            art={<KeyIcon size={24} color={c.ink} />}
            title={title ?? t('booking.code', { code: bookingCode(b.id) })}
            meta={[
              bookingCode(b.id),
              t(`booking.as.${b.renterId === me ? 'RENTER' : 'OWNER'}`),
              t('dash.period', { from: date(b.startAt, 'short'), to: date(b.endAt, 'short') }),
              f.taka(b.amount),
              f.state(b.status),
            ].join(' · ')}
            onPress={() => nav.navigate('Booking', { id: b.id })}
          />
        );
      }}
      header={
        <Stack>
          <T color={c.inkSoft}>{t('bookings.lede')}</T>
          <Chips
            label={t('bookings.role')}
            value={role}
            onChange={(v) => setRole(v as '' | 'renter' | 'owner')}
            options={[
              { value: '', label: t('bookings.role.all') },
              { value: 'renter', label: t('bookings.role.renter') },
              { value: 'owner', label: t('bookings.role.owner') },
            ]}
          />
        </Stack>
      }
    />
  );
}
