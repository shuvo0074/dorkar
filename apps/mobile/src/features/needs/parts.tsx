import type { NeedMode } from '@dorkar/contracts';
import type { ReactNode } from 'react';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { c, modeTint, r, space } from '../../design/tokens';
import { useI18n } from '../../lib/i18n';
import { useNav } from '../../nav/routes';
import { Button } from '../../ui/Button';
import { Divider, Empty, Loading, Screen, Stack } from '../../ui/Layout';
import { T } from '../../ui/Text';
import { modeIcon } from './modeIcons';

/** The need's mode as a tinted tile with its icon. */
export function ModeTile({ mode, size = 48 }: { mode: NeedMode; size?: number }) {
  const Icon = modeIcon[mode];
  return (
    <View style={[styles.tile, { width: size, height: size, backgroundColor: modeTint[mode] }]}>
      <Icon size={size / 2} color={c.ink} />
    </View>
  );
}

/** One row of a personal list: art, a linked headline, a meta line, then anything below it. */
export function LedgerRow({
  art,
  title,
  meta,
  aside,
  onPress,
  children,
}: {
  art?: ReactNode;
  title: string;
  meta: string;
  aside?: ReactNode;
  onPress: () => void;
  children?: ReactNode;
}) {
  return (
    <View style={styles.rowWrap}>
      <Pressable
        accessibilityRole="link"
        onPress={onPress}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        {art}
        <View style={styles.rowText}>
          <T v="bodyStrong" numberOfLines={2}>
            {title}
          </T>
          <T v="small" color={c.inkSoft}>
            {meta}
          </T>
          {aside}
        </View>
      </Pressable>
      {children}
    </View>
  );
}

/** Rows with hairlines between them, for lists inside a scrolling page. */
export function Rows({ children }: { children: ReactNode[] }) {
  return (
    <View>
      {children.map((child, i) => (
        <View key={i}>
          {i > 0 ? <Divider /> : null}
          {child}
        </View>
      ))}
    </View>
  );
}

/** One line of a history: when, what, and an optional quiet note. */
export function TimelineItem({
  at,
  text,
  note,
}: {
  at: string;
  text: string;
  note?: string | null | undefined;
}) {
  const { date } = useI18n();
  return (
    <View style={styles.timeline}>
      <T v="code" color={c.inkSoft}>
        {date(at)}
      </T>
      <T v="small">{text}</T>
      {note ? (
        <T v="small" color={c.inkSoft}>
          {note}
        </T>
      ) : null}
    </View>
  );
}

/** A fact's value with quieter lines under it. */
export function FactValue({ children }: { children: string }) {
  return (
    <T v="bodyStrong" align="right">
      {children}
    </T>
  );
}

export function FactAside({ children }: { children: string }) {
  return (
    <T v="small" color={c.inkSoft} align="right">
      {children}
    </T>
  );
}

/** The page behind a dead link. */
export function NotFound() {
  const { t } = useI18n();
  const nav = useNav();
  return (
    <Screen>
      <Empty
        title={t('notFound.title')}
        body={t('notFound.body')}
        action={
          <Button
            kind="outline"
            label={t('notFound.back')}
            onPress={() => nav.navigate('Tabs', { screen: 'Home' })}
          />
        }
      />
    </Screen>
  );
}

/** Pull to refresh, load on scroll, the gutter and hairlines: what every paged FlatList needs. */
export function usePagedListProps(query: {
  hasNextPage: boolean;
  isFetching: boolean;
  isFetchingNextPage: boolean;
  isRefetching: boolean;
  fetchNextPage: () => unknown;
  refetch: () => unknown;
}) {
  const insets = useSafeAreaInsets();
  return {
    keyboardShouldPersistTaps: 'handled' as const,
    contentContainerStyle: [styles.list, { paddingBottom: insets.bottom + space.section }],
    ItemSeparatorComponent: Divider,
    ListHeaderComponentStyle: styles.listHead,
    ListFooterComponent: query.isFetchingNextPage ? <Loading /> : undefined,
    onEndReachedThreshold: 0.4,
    onEndReached: () => {
      if (query.hasNextPage && !query.isFetching) void query.fetchNextPage();
    },
    refreshControl: (
      <RefreshControl
        refreshing={query.isRefetching && !query.isFetchingNextPage}
        onRefresh={() => void query.refetch()}
        tintColor={c.accent}
        colors={[c.brand]}
      />
    ),
  };
}

/** The title block over a list: the lede and the page's actions. */
export function ListHead({ children }: { children: ReactNode }) {
  return <Stack gap={space.gap}>{children}</Stack>;
}

const styles = StyleSheet.create({
  tile: { borderRadius: r.control, alignItems: 'center', justifyContent: 'center' },
  rowWrap: { paddingVertical: 10, gap: 10 },
  row: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  pressed: { opacity: 0.6 },
  rowText: { flex: 1, gap: 1 },
  timeline: { gap: 2, paddingVertical: 6 },
  list: { paddingHorizontal: space.gutter, paddingTop: space.gutter },
  listHead: { marginBottom: space.section },
});
