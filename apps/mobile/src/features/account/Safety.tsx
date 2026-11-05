import { chatApi } from '@web/features/messages/api';
import { trustApi, type ReportTarget } from '@web/features/trust/api';
import { useFormat } from '@web/lib/format';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { StyleSheet, View } from 'react-native';
import { c } from '../../design/tokens';
import { useI18n } from '../../lib/i18n';
import { useNav } from '../../nav/routes';
import { Button, LinkText } from '../../ui/Button';
import { Divider, Section, Stack } from '../../ui/Layout';
import { MoreButton, Skeleton, usePaged } from '../../ui/Misc';
import { T } from '../../ui/Text';
import { goTo, type NavTarget } from '../notifications/links';
import { UserLink } from '../trust/UserLink';

/** Where a reported thing can be seen, when it has a page of its own. */
function targetRoute(type: ReportTarget, id: string): NavTarget | null {
  switch (type) {
    case 'LISTING':
      return { name: 'Listing', params: { id } };
    case 'NEED':
      return { name: 'Need', params: { id } };
    case 'OFFER':
      return { name: 'Offer', params: { id } };
    case 'USER':
      return { name: 'User', params: { id } };
    case 'AUCTION':
      return { name: 'Auction', params: { id } };
    case 'LEND_ITEM':
      return { name: 'LendItem', params: { id } };
    default:
      return null;
  }
}

/** People the member blocked, with a way back. */
export function BlockedPeople() {
  const { t, date } = useI18n();
  const qc = useQueryClient();
  const list = usePaged(['me', 'blocked'], (cursor) => chatApi.blocked(cursor));
  const unblock = useMutation({
    mutationFn: chatApi.unblock,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['me', 'blocked'] }),
  });
  return (
    <Section title={t('blocked.title')}>
      {list.isPending ? <Skeleton /> : null}
      {list.data && list.rows.length === 0 ? <T color={c.inkSoft}>{t('blocked.empty')}</T> : null}
      {list.rows.map((b) => (
        <Stack key={b.userId} gap={12}>
          <View style={styles.row}>
            <View style={styles.text}>
              <UserLink userId={b.userId} />
              <T v="small" color={c.inkSoft}>
                {t('blocked.since', { when: date(b.blockedAt, 'short') })}
              </T>
            </View>
            <Button
              kind="link"
              small
              disabled={unblock.isPending}
              label={t('chat.unblock')}
              onPress={() => unblock.mutate(b.userId)}
            />
          </View>
          <Divider />
        </Stack>
      ))}
      <MoreButton query={list} />
    </Section>
  );
}

/** What the member reported and what became of it. */
export function MyReports() {
  const { t } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const list = usePaged(['me', 'reports'], (cursor) => trustApi.myReports(cursor));
  return (
    <Section title={t('reports.title')}>
      {list.isPending ? <Skeleton /> : null}
      {list.data && list.rows.length === 0 ? <T color={c.inkSoft}>{t('reports.empty')}</T> : null}
      {list.rows.map((r) => {
        const target = targetRoute(r.targetType, r.targetId);
        return (
          <Stack key={r.id} gap={12}>
            <View style={styles.row}>
              <View style={styles.text}>
                {target ? (
                  <LinkText label={t(`target.${r.targetType}`)} onPress={() => goTo(nav, target)} />
                ) : (
                  <T v="bodyStrong">{t(`target.${r.targetType}`)}</T>
                )}
                <T v="small" color={c.inkSoft}>
                  {t(`report.reason.${r.reason}`)} · {f.relative(r.createdAt)}
                </T>
              </View>
              <T v="code">{t(`reports.status.${r.status}`)}</T>
            </View>
            <Divider />
          </Stack>
        );
      })}
      <MoreButton query={list} />
    </Section>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: 44,
  },
  text: { flex: 1, gap: 2 },
});
