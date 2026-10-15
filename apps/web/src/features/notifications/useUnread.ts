import { useQuery } from '@tanstack/react-query';
import { useSession } from '../auth/session';
import { notificationsApi } from './api';

/** The unread count for the nav, checked once a minute while signed in and the tab is visible. */
export function useUnread(): number {
  const { status } = useSession();
  const q = useQuery({
    queryKey: ['me', 'unread'],
    queryFn: notificationsApi.unreadCount,
    enabled: status === 'signedIn',
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
  });
  return q.data ?? 0;
}
