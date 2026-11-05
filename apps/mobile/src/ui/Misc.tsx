import type { ReactNode } from 'react';
import { Image, StyleSheet, View, type ImageStyle, type StyleProp } from 'react-native';
import { useInfiniteQuery, useQuery, type QueryKey } from '@tanstack/react-query';
import { c, r } from '../design/tokens';
import { mediaApi } from '../features/media/api';
import type { Page } from '../lib/http';
import { useI18n } from '../lib/i18n';
import { Button } from './Button';
import { T } from './Text';

/** Rounded status label: `tone` picks the colour, the server's state picks the words. */
export function Badge({
  label,
  tone = 'quiet',
}: {
  label: string;
  tone?: 'quiet' | 'good' | 'warn' | 'hot';
}) {
  const bg =
    tone === 'good'
      ? c.brandTint
      : tone === 'warn'
      ? c.redTint
      : tone === 'hot'
      ? c.hot
      : c.paperShade;
  const fg =
    tone === 'good' ? c.brandInk : tone === 'warn' ? c.redInk : tone === 'hot' ? c.onHot : c.ink;
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <T v="code" color={fg}>
        {label}
      </T>
    </View>
  );
}

/** Label and value, for terms and details. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.fact}>
      <T v="small" color={c.inkSoft} style={styles.factLabel}>
        {label}
      </T>
      {typeof children === 'string' || typeof children === 'number' ? (
        <T v="bodyStrong" style={styles.factValue}>
          {children}
        </T>
      ) : (
        <View style={styles.factValue}>{children}</View>
      )}
    </View>
  );
}

/** Dashed receipt-style placeholder lines while something loads. */
export function Skeleton({ rows = 2 }: { rows?: number }) {
  return (
    <View style={styles.skeletons} accessibilityElementsHidden>
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={[styles.skeleton, { width: i % 2 ? '45%' : '70%' }]} />
      ))}
    </View>
  );
}

/** Signed links expire after ten minutes; refresh a little before that. */
export function useMedia(id: string | undefined) {
  return useQuery({
    queryKey: ['media', id],
    queryFn: () => mediaApi.get(id!),
    enabled: Boolean(id),
    staleTime: 8 * 60_000,
    refetchInterval: 9 * 60_000,
  });
}

/** One stored photo; shows `fallback` while loading or when unavailable. */
export function MediaImage({
  id,
  variant = 'thumb',
  alt,
  fallback = null,
  style,
}: {
  id: string | undefined;
  variant?: 'thumb' | 'medium' | 'original';
  alt?: string;
  fallback?: ReactNode;
  style?: StyleProp<ImageStyle>;
}) {
  const media = useMedia(id);
  const src = media.data?.urls[variant] ?? media.data?.urls.original;
  if (!src) return <>{fallback}</>;
  return (
    <Image
      source={{ uri: src }}
      style={style}
      resizeMode="cover"
      accessible={Boolean(alt)}
      {...(alt ? { accessibilityLabel: alt } : {})}
    />
  );
}

/** A cursor-paginated list as one flat array. Same shape as the web's hook. */
export function usePaged<P extends Page<unknown>>(
  queryKey: QueryKey,
  fetch: (cursor: string | undefined) => Promise<P>,
  opts: { enabled?: boolean; refetchInterval?: number } = {},
) {
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => fetch(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}),
    ...(opts.refetchInterval ? { refetchInterval: opts.refetchInterval } : {}),
  });
  const rows = (query.data?.pages.flatMap((p) => p.data) ?? []) as Array<P['data'][number]>;
  return { ...query, rows };
}

export function MoreButton({
  query,
  label,
}: {
  query: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown };
  label?: string;
}) {
  const { t } = useI18n();
  if (!query.hasNextPage) return null;
  return (
    <Button
      kind="outline"
      small
      block
      busy={query.isFetchingNextPage}
      label={label ?? t('common.more')}
      onPress={() => void query.fetchNextPage()}
    />
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: r.chip,
  },
  fact: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    alignItems: 'flex-start',
  },
  factLabel: { flex: 1 },
  factValue: { flex: 1.4, alignItems: 'flex-end', textAlign: 'right' },
  skeletons: { gap: 10 },
  skeleton: { height: 14, borderRadius: 7, backgroundColor: c.skeleton },
});
