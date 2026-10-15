import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query';
import type { Page } from '../../lib/http';
import { useI18n } from '../../lib/i18n';

/** A cursor-paginated list as one flat array, loading further pages on demand. */
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
    <div className="logmore">
      <button
        type="button"
        className="btn btn--outline btn--small"
        disabled={query.isFetchingNextPage}
        onClick={() => void query.fetchNextPage()}
      >
        {query.isFetchingNextPage ? t('loading') : (label ?? t('common.more'))}
      </button>
    </div>
  );
}
