import { itemCode, lendingApi, loanCode } from '@web/features/lending/api';
import { useFormat } from '@web/lib/format';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { c } from '../design/tokens';
import { useSession } from '../features/auth/session';
import { LedgerRow, PagedSection, useRefresh } from '../features/catalog/pageParts';
import { useI18n } from '../lib/i18n';
import { SignedInOnly } from '../nav/SignedInOnly';
import { useNav } from '../nav/routes';
import { Button } from '../ui/Button';
import { Chips } from '../ui/Fields';
import { BorrowIcon } from '../ui/icons';
import { Screen, Stack } from '../ui/Layout';
import { usePaged } from '../ui/Misc';
import { T } from '../ui/Text';

export default function LoansScreen() {
  return (
    <SignedInOnly>
      <Page />
    </SignedInOnly>
  );
}

function Page() {
  const { t } = useI18n();
  const nav = useNav();
  const qc = useQueryClient();
  const pull = useRefresh(() =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['me', 'loans'] }),
      qc.invalidateQueries({ queryKey: ['me', 'lend-items'] }),
    ]),
  );
  return (
    <Screen {...pull}>
      <Stack>
        <T color={c.inkSoft}>{t('loans.lede')}</T>
        <Button small label={t('lend.lendYours')} onPress={() => nav.navigate('LendForm')} />
      </Stack>
      <Loans />
      <Items />
    </Screen>
  );
}

function Loans() {
  const { t, date } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const me = useSession().account?.id;
  const [role, setRole] = useState<'' | 'lender' | 'borrower'>('');
  const list = usePaged(['me', 'loans', role], (cursor) =>
    lendingApi.myLoans({ role: role || undefined }, cursor),
  );
  return (
    <PagedSection
      title={t('loans.loans')}
      query={list}
      skeleton={3}
      empty={t('loans.empty')}
      before={
        <Chips
          label={t('bookings.role')}
          value={role}
          onChange={(v) => setRole(v as '' | 'lender' | 'borrower')}
          options={[
            { value: '', label: t('bookings.role.all') },
            { value: 'borrower', label: t('dash.role.BORROWER') },
            { value: 'lender', label: t('dash.role.LENDER') },
          ]}
        />
      }
      renderRow={(l) => (
        <LedgerRow
          art={<BorrowIcon size={24} color={c.ink} />}
          title={l.itemTitle}
          meta={[
            loanCode(l.id),
            t(`loan.as.${l.lenderId === me ? 'LENDER' : 'BORROWER'}`),
            t('dash.returnBy', { when: date(l.returnBy, 'short') }),
            f.state(l.status),
            l.overdue && t('loan.overdue'),
          ]
            .filter(Boolean)
            .join(' · ')}
          onPress={() => nav.navigate('Loan', { id: l.id })}
        />
      )}
    />
  );
}

function Items() {
  const { t } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const list = usePaged(['me', 'lend-items'], (cursor) => lendingApi.myItems(cursor));
  return (
    <PagedSection
      title={t('loans.items')}
      query={list}
      empty={t('loans.noItems')}
      renderRow={(i) => (
        <LedgerRow
          artText={itemCode(i.id)}
          title={i.title}
          meta={[
            f.district(i.district),
            i.active ? f.state('ACTIVE') : t('lend.inactive'),
            i.hidden && f.state('HIDDEN'),
          ]
            .filter(Boolean)
            .join(' · ')}
          onPress={() => nav.navigate('LendItem', { id: i.id })}
        />
      )}
    />
  );
}
