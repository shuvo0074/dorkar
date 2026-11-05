import { shortCode } from '@web/lib/format';
import { trustApi } from '@web/features/trust/api';
import { useQuery } from '@tanstack/react-query';
import { useI18n } from '../../lib/i18n';
import { useNav } from '../../nav/routes';
import { LinkText } from '../../ui/Button';

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
  const nav = useNav();
  const profile = useProfile(userId);
  return (
    <LinkText
      label={profile.data?.displayName ?? t('common.member', { code: shortCode('M', userId) })}
      onPress={() => nav.navigate('User', { id: userId })}
    />
  );
}
