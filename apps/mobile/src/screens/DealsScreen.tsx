import { dealCode, dealsApi, dealTitle, finalStates } from '@web/features/deals/api';
import { useFormat } from '@web/lib/format';
import { useState } from 'react';
import { FlatList } from 'react-native';
import { c } from '../design/tokens';
import { useSession } from '../features/auth/session';
import { LedgerRow, ListHead, ModeTile, usePagedListProps } from '../features/needs/parts';
import { useI18n } from '../lib/i18n';
import { useNav } from '../nav/routes';
import { SignedInOnly } from '../nav/SignedInOnly';
import { LinkText } from '../ui/Button';
import { Chips, FieldShell } from '../ui/Fields';
import { Empty, LoadError, Screen } from '../ui/Layout';
import { Skeleton, usePaged } from '../ui/Misc';
import { T } from '../ui/Text';

export default function DealsScreen() {
  return (
    <SignedInOnly>
      <Deals />
    </SignedInOnly>
  );
}

function Deals() {
  const { t, num } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const me = useSession().account?.id;
  const [role, setRole] = useState<'' | 'buyer' | 'seller'>('');
  const [scope, setScope] = useState<'live' | 'all'>('live');
  const list = usePaged(['me', 'deals', role], (cursor) =>
    dealsApi.mine({ role: role || undefined }, cursor),
  );
  const listProps = usePagedListProps(list);
  const rows = scope === 'live' ? list.rows.filter((d) => !finalStates.has(d.state)) : list.rows;

  return (
    <Screen scroll={false}>
      <FlatList
        {...listProps}
        data={rows}
        keyExtractor={(d) => d.id}
        renderItem={({ item: d }) => (
          <LedgerRow
            art={<ModeTile mode={d.mode} />}
            title={dealTitle(d) ?? t('deals.code', { code: dealCode(d.id) })}
            meta={[
              dealCode(d.id),
              t(`deals.as.${d.buyerId === me ? 'BUYER' : 'SELLER'}`),
              `${f.taka(d.amount)}${d.quantity > 1 ? ` × ${num(d.quantity)}` : ''}`,
              f.state(d.state),
              f.relative(d.updatedAt),
            ].join(' · ')}
            onPress={() => nav.navigate('Deal', { id: d.id })}
          />
        )}
        ListHeaderComponent={
          <ListHead>
            <LinkText
              label={t('nav.dashboard')}
              onPress={() => nav.navigate('Tabs', { screen: 'Dashboard' })}
            />
            <T color={c.inkSoft}>{t('deals.lede')}</T>
            <T v="section" accessibilityRole="header">
              {t('nav.deals')}
            </T>
            <FieldShell label={t('deals.role')}>
              <Chips
                label={t('deals.role')}
                value={role}
                onChange={(v) => setRole(v as typeof role)}
                options={[
                  { value: '', label: t('deals.role.all') },
                  { value: 'buyer', label: t('deals.role.buyer') },
                  { value: 'seller', label: t('deals.role.seller') },
                ]}
              />
            </FieldShell>
            <FieldShell label={t('deals.state')}>
              <Chips
                label={t('deals.state')}
                value={scope}
                onChange={(v) => setScope(v as typeof scope)}
                options={[
                  { value: 'live', label: t('deals.state.live') },
                  { value: 'all', label: t('deals.state.all') },
                ]}
              />
            </FieldShell>
            {list.isPending ? <Skeleton rows={4} /> : null}
            {list.isError ? <LoadError onRetry={() => void list.refetch()} /> : null}
          </ListHead>
        }
        ListEmptyComponent={
          list.data ? (
            <Empty title={t(list.rows.length ? 'deals.emptyFilter' : 'deals.empty')} />
          ) : undefined
        }
      />
    </Screen>
  );
}
