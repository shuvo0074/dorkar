import { dealCode } from '@web/features/deals/api';
import { disputesApi } from '@web/features/disputes/api';
import { shortCode, useFormat } from '@web/lib/format';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { c, r, space } from '../design/tokens';
import { useI18n } from '../lib/i18n';
import { useNav } from '../nav/routes';
import { SignedInOnly } from '../nav/SignedInOnly';
import { ShieldIcon } from '../ui/icons';
import { Card, LoadError, Screen, Stack } from '../ui/Layout';
import { Skeleton, usePaged } from '../ui/Misc';
import { T } from '../ui/Text';

export default function DisputesScreen() {
  return (
    <SignedInOnly>
      <MyDisputes />
    </SignedInOnly>
  );
}

function MyDisputes() {
  const { t } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const list = usePaged(['me', 'disputes'], (cursor) => disputesApi.mine(undefined, cursor));
  return (
    <Screen scroll={false}>
      <FlatList
        data={list.rows}
        keyExtractor={(d) => d.id}
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={Gap}
        refreshing={list.isRefetching && !list.isFetchingNextPage}
        onRefresh={() => void list.refetch()}
        onEndReachedThreshold={0.4}
        onEndReached={() => {
          if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
        }}
        ListHeaderComponent={
          <Stack style={styles.header}>
            <T color={c.inkSoft}>{t('disputes.lede')}</T>
            {list.isPending ? <Skeleton rows={3} /> : null}
            {list.isError ? <LoadError onRetry={() => void list.refetch()} /> : null}
            {list.data && list.rows.length === 0 ? (
              <T color={c.inkSoft}>{t('disputes.empty')}</T>
            ) : null}
          </Stack>
        }
        renderItem={({ item: d }) => (
          <Pressable accessibilityRole="link" onPress={() => nav.navigate('Dispute', { id: d.id })}>
            <Card style={styles.row}>
              <View style={styles.tile}>
                <ShieldIcon size={22} color={c.ink} />
              </View>
              <View style={styles.text}>
                <T v="bodyStrong">{t(`reason.${d.reason}`)}</T>
                <T v="small" color={c.inkSoft}>
                  {[
                    shortCode('D', d.id),
                    t('dispute.onDeal', { code: dealCode(d.transactionId) }),
                    f.state(d.status),
                    f.relative(d.updatedAt),
                  ].join(' · ')}
                </T>
              </View>
            </Card>
          </Pressable>
        )}
      />
    </Screen>
  );
}

const Gap = () => <View style={styles.gap} />;

const styles = StyleSheet.create({
  list: { padding: space.gutter },
  header: { marginBottom: space.gap },
  gap: { height: space.gap },
  row: { flexDirection: 'row', alignItems: 'center' },
  tile: {
    width: 44,
    height: 44,
    borderRadius: r.control,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.paperShade,
  },
  text: { flex: 1, gap: 2 },
});
