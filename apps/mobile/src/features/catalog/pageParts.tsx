import { useNavigation } from '@react-navigation/native';
import { useLayoutEffect, useState, type ReactNode } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
  type ListRenderItem,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { c, cardEdge, elevation, r, space } from '../../design/tokens';
import { useI18n } from '../../lib/i18n';
import { useNav } from '../../nav/routes';
import { Button } from '../../ui/Button';
import { Card, Divider, Empty, LoadError, Row, Screen, Section, Stack } from '../../ui/Layout';
import { MediaImage, MoreButton, Skeleton } from '../../ui/Misc';
import { T } from '../../ui/Text';

/** The header's words for a page whose title depends on what it shows. */
export function useTitle(title: string) {
  const nav = useNavigation();
  useLayoutEffect(() => nav.setOptions({ title }), [nav, title]);
}

/** Pull to refresh that spins only for the pull, not for a page's background polling. */
export function useRefresh(fn: () => Promise<unknown>) {
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = () => {
    setRefreshing(true);
    void fn().finally(() => setRefreshing(false));
  };
  return { refreshing, onRefresh };
}

/** Twin of the web's NotFoundRoute, for a detail page whose record is gone. */
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

/** A page's first paint: placeholder lines in the usual gutter. */
export const PageSkeleton = ({ rows = 6 }: { rows?: number }) => (
  <Screen>
    <Skeleton rows={rows} />
  </Screen>
);

/** A page that failed to load, with its retry. */
export const PageError = ({ onRetry }: { onRetry: () => void }) => (
  <Screen>
    <LoadError onRetry={onRetry} />
  </Screen>
);

interface PagedQuery<R> {
  rows: R[];
  data: unknown;
  isPending: boolean;
  isError: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => unknown;
  refetch: () => Promise<unknown>;
}

/** A whole page that is one paged list: header above, pull to refresh, more on reaching the end. */
export function PagedList<R extends { id: string }>({
  query,
  renderRow,
  header,
  empty,
  columns = 1,
  skeleton = 4,
  moreLabel,
}: {
  query: PagedQuery<R>;
  renderRow: (row: R) => ReactNode;
  header?: ReactNode;
  empty: string;
  columns?: 1 | 2;
  skeleton?: number;
  moreLabel?: string;
}) {
  const insets = useSafeAreaInsets();
  const { refreshing, onRefresh } = useRefresh(() => query.refetch());
  // A filler keeps an odd last card at half width, since cards grow to fill their row.
  const data: Array<R | null> =
    columns === 2 && query.rows.length % 2 === 1 ? [...query.rows, null] : query.rows;
  const renderItem: ListRenderItem<R | null> = ({ item }) =>
    item ? <>{renderRow(item)}</> : <View style={styles.flex} />;
  return (
    <Screen scroll={false}>
      <FlatList
        key={columns}
        data={data}
        numColumns={columns}
        {...(columns === 2 ? { columnWrapperStyle: styles.columns } : {})}
        keyExtractor={(row) => row?.id ?? '__filler'}
        renderItem={renderItem}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + space.section }]}
        ItemSeparatorComponent={columns === 2 ? RowGap : Divider}
        ListHeaderComponent={
          <View style={styles.listHead}>
            {header}
            {query.isError ? <LoadError onRetry={() => void query.refetch()} /> : null}
          </View>
        }
        ListEmptyComponent={
          <>
            {query.isPending ? <Skeleton rows={skeleton} /> : null}
            {query.data && !query.isError ? <T color={c.inkSoft}>{empty}</T> : null}
          </>
        }
        ListFooterComponent={
          <View style={styles.listFoot}>
            <MoreButton query={query} {...(moreLabel ? { label: moreLabel } : {})} />
          </View>
        }
        onEndReachedThreshold={0.4}
        onEndReached={() => {
          if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={c.accent}
            colors={[c.brand]}
          />
        }
      />
    </Screen>
  );
}

const RowGap = () => <View style={styles.rowGap} />;

/** Titled filters, folded behind a button so the results come first. */
export function FilterPanel({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <View style={styles.filterBar}>
        <T v="section" accessibilityRole="header" style={styles.shrink}>
          {title}
        </T>
        <Button
          kind="outline"
          small
          label={open ? t('common.hideFilters') : t('common.showFilters')}
          onPress={() => setOpen((o) => !o)}
        />
      </View>
      {open ? <Stack>{children}</Stack> : null}
    </Card>
  );
}

/** One numbered part of a long form. */
export function FormSection({
  n,
  title,
  children,
}: {
  n?: number;
  title?: string;
  children: ReactNode;
}) {
  const { num } = useI18n();
  return (
    <Card>
      {title ? (
        <Section title={n ? `${num(n)}. ${title}` : title}>{children}</Section>
      ) : (
        <Stack>{children}</Stack>
      )}
    </Card>
  );
}

/** A record as a row: a small tile, its title and one line of facts. */
export function LedgerRow({
  art,
  artText,
  title,
  meta,
  onPress,
}: {
  art?: ReactNode;
  /** A word or code on the tile instead of a picture. */
  artText?: string;
  title: string;
  meta: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="link"
      style={({ pressed }) => [styles.ledger, pressed && styles.pressed]}
      onPress={onPress}
    >
      {artText ? (
        <View style={[styles.tile, styles.tileText]}>
          <T v="code" color={c.inkSoft} numberOfLines={1}>
            {artText}
          </T>
        </View>
      ) : (
        <View style={styles.tile}>{art}</View>
      )}
      <View style={styles.flex}>
        <T v="bodyStrong" numberOfLines={2}>
          {title}
        </T>
        <T v="small" color={c.inkSoft}>
          {meta}
        </T>
      </View>
    </Pressable>
  );
}

/** Size for a stored photo inside a LedgerRow's tile. */
export const ledgerPhoto = { width: 48, height: 48 } as const;

/** A paged section inside a scrolling page, for pages that hold more than one list. */
export function PagedSection<R extends { id: string }>({
  title,
  query,
  renderRow,
  before,
  empty,
  skeleton = 2,
}: {
  title: string;
  query: Omit<PagedQuery<R>, 'refetch'> & { refetch: () => unknown };
  renderRow: (row: R) => ReactNode;
  before?: ReactNode;
  empty: string;
  skeleton?: number;
}) {
  return (
    <Section title={title}>
      {before}
      {query.isPending ? <Skeleton rows={skeleton} /> : null}
      {query.isError ? <LoadError onRetry={() => void query.refetch()} /> : null}
      {query.data && query.rows.length === 0 ? <T color={c.inkSoft}>{empty}</T> : null}
      {query.rows.length > 0 ? (
        <View>
          {query.rows.map((row, i) => (
            <View key={row.id}>
              {i > 0 ? <Divider /> : null}
              {renderRow(row)}
            </View>
          ))}
        </View>
      ) : null}
      <MoreButton query={query} />
    </Section>
  );
}

/** One step in a record's history. */
export function TimelineRow({ at, line, sub }: { at: string; line: string; sub?: string }) {
  return (
    <View style={styles.timeline}>
      <T v="code" color={c.inkSoft}>
        {at}
      </T>
      <T>{line}</T>
      {sub ? (
        <T v="small" color={c.inkSoft}>
          {sub}
        </T>
      ) : null}
    </View>
  );
}

/** Photos: one large, with a row of thumbnails to switch when there are several. */
export function Gallery({
  ids,
  fallback,
  label,
}: {
  ids: string[];
  fallback: ReactNode;
  label: string;
}) {
  const { t, num } = useI18n();
  const [shown, setShown] = useState(0);
  const current = ids[shown] ?? ids[0];
  const stamp = <View style={styles.stamp}>{fallback}</View>;
  return (
    <Stack>
      <View style={styles.galleryMain}>
        {current ? (
          <MediaImage
            id={current}
            variant="medium"
            style={styles.fill}
            alt={t('photos.photo', { n: num(shown + 1) })}
            fallback={stamp}
          />
        ) : (
          stamp
        )}
      </View>
      {ids.length > 1 ? (
        <Row>
          {ids.map((m, i) => (
            <Pressable
              key={m}
              accessibilityRole="button"
              accessibilityHint={label}
              accessibilityState={{ selected: i === shown }}
              accessibilityLabel={t('photos.photo', { n: num(i + 1) })}
              style={[styles.thumb, i === shown && styles.thumbOn]}
              onPress={() => setShown(i)}
            >
              <MediaImage id={m} style={styles.fill} />
            </Pressable>
          ))}
        </Row>
      ) : null}
    </Stack>
  );
}

/** A browsable record as a card with art on top; lay these out two to a row. */
export function EntryCard({
  art,
  code,
  title,
  meta,
  onPress,
}: {
  art: ReactNode;
  code: string;
  title: string;
  meta: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="link"
      style={({ pressed }) => [styles.card, elevation.card, cardEdge, pressed && styles.pressed]}
      onPress={onPress}
    >
      <View style={styles.cardArt}>{art}</View>
      <View style={styles.cardText}>
        <T v="code" color={c.inkSoft}>
          {code}
        </T>
        <T v="bodyStrong" numberOfLines={2}>
          {title}
        </T>
        <T v="small" color={c.inkSoft} numberOfLines={2}>
          {meta}
        </T>
      </View>
    </Pressable>
  );
}

/** Centres a glyph in an EntryCard's art. */
export const EntryStamp = ({ children }: { children: ReactNode }) => (
  <View style={styles.stamp}>{children}</View>
);
export const entryPhoto = { width: '100%', height: '100%' } as const;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  shrink: { flexShrink: 1 },
  fill: { width: '100%', height: '100%' },
  pressed: { opacity: 0.6 },
  list: { padding: space.gutter },
  listHead: { gap: space.section, paddingBottom: space.gap },
  listFoot: { paddingTop: space.gap },
  columns: { gap: space.gap },
  rowGap: { height: space.gap },
  filterBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.gap,
  },
  ledger: { flexDirection: 'row', gap: space.gap, paddingVertical: 10, alignItems: 'center' },
  tile: {
    width: 48,
    height: 48,
    borderRadius: r.control,
    backgroundColor: c.paperShade,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  tileText: { width: 72, paddingHorizontal: 4 },
  timeline: { gap: 2, paddingVertical: 8 },
  galleryMain: {
    aspectRatio: 4 / 3,
    borderRadius: r.card,
    overflow: 'hidden',
    backgroundColor: c.paperShade,
  },
  stamp: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  thumb: {
    width: 64,
    height: 64,
    borderRadius: r.control,
    overflow: 'hidden',
    backgroundColor: c.paperShade,
    borderWidth: 2,
    borderColor: c.paperShade,
  },
  thumbOn: { borderColor: c.accent },
  card: { flex: 1, backgroundColor: c.paper, borderRadius: r.tile },
  cardArt: {
    aspectRatio: 1,
    backgroundColor: c.paperShade,
    borderTopLeftRadius: r.tile,
    borderTopRightRadius: r.tile,
    overflow: 'hidden',
  },
  cardText: { padding: 10, gap: 2 },
});
