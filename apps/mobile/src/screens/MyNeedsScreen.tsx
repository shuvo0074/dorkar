import { needsApi, type NeedStatus } from '@web/features/needs/api';
import { needCode } from '@web/features/needs/modes';
import { useFormat } from '@web/lib/format';
import { useState } from 'react';
import { FlatList } from 'react-native';
import { c } from '../design/tokens';
import { LedgerRow, ListHead, ModeTile, usePagedListProps } from '../features/needs/parts';
import { useI18n } from '../lib/i18n';
import { useNav } from '../nav/routes';
import { SignedInOnly } from '../nav/SignedInOnly';
import { Button, LinkText } from '../ui/Button';
import { Chips } from '../ui/Fields';
import { Empty, LoadError, Screen } from '../ui/Layout';
import { Skeleton, usePaged } from '../ui/Misc';
import { T } from '../ui/Text';

const FILTERS = ['', 'OPEN', 'DRAFT', 'PAUSED', 'FULFILLING', 'EXPIRED', 'CLOSED'] as const;

export default function MyNeedsScreen() {
  return (
    <SignedInOnly>
      <MyNeeds />
    </SignedInOnly>
  );
}

function MyNeeds() {
  const { t } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const [status, setStatus] = useState<(typeof FILTERS)[number]>('');
  const list = usePaged(['me', 'needs', status], (cursor) =>
    needsApi.mine((status || undefined) as NeedStatus | undefined, cursor),
  );
  const listProps = usePagedListProps(list);

  return (
    <Screen scroll={false}>
      <FlatList
        {...listProps}
        data={list.rows}
        keyExtractor={(n) => n.id}
        renderItem={({ item: n }) => (
          <LedgerRow
            art={<ModeTile mode={n.mode} />}
            title={n.title}
            meta={[
              needCode(n),
              f.state(n.status),
              t('myNeeds.offers', { n: n.offerCount }),
              t('myNeeds.updated', { when: f.relative(n.updatedAt) }),
            ].join(' · ')}
            onPress={() => nav.navigate('Need', { id: n.id })}
          />
        )}
        ListHeaderComponent={
          <ListHead>
            <LinkText
              label={t('nav.dashboard')}
              onPress={() => nav.navigate('Tabs', { screen: 'Dashboard' })}
            />
            <T color={c.inkSoft}>{t('myNeeds.lede')}</T>
            <Button small label={t('myNeeds.post')} onPress={() => nav.navigate('NeedForm')} />
            <T v="section" accessibilityRole="header">
              {t('feed.results')}
            </T>
            <Chips
              label={t('myNeeds.status')}
              value={status}
              onChange={(v) => setStatus(v as (typeof FILTERS)[number])}
              options={FILTERS.map((s) => ({ value: s, label: s ? f.state(s) : t('myNeeds.all') }))}
            />
            {list.isPending ? <Skeleton rows={4} /> : null}
            {list.isError ? <LoadError onRetry={() => void list.refetch()} /> : null}
          </ListHead>
        }
        ListEmptyComponent={
          list.data ? (
            <Empty title={t(status ? 'myNeeds.emptyStatus' : 'myNeeds.empty')} />
          ) : undefined
        }
      />
    </Screen>
  );
}
