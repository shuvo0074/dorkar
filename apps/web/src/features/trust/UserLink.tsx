import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { shortCode } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { trustApi } from './api';

export function useProfile(userId: string | null | undefined) {
  return useQuery({
    queryKey: ['users', userId],
    queryFn: () => trustApi.profile(userId!),
    enabled: Boolean(userId),
    staleTime: 5 * 60_000,
  });
}

/** A member's public name, linked to their profile. Falls back to their member code. */
export function UserLink({ userId }: { userId: string }) {
  const { t } = useI18n();
  const profile = useProfile(userId);
  return (
    <Link to={`/users/${userId}`}>
      {profile.data?.displayName ?? t('common.member', { code: shortCode('M', userId) })}
    </Link>
  );
}
