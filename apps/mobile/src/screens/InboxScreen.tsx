import { notificationsApi, type Notification } from '@web/features/notifications/api';
import { useNotificationText } from '@web/features/notifications/text';
import { useFormat } from '@web/lib/format';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { TabSignedIn, useTabTop } from '../features/account/TabPage';
import { goTo, routeForPath } from '../features/notifications/links';
import { useUnread } from '../features/notifications/useUnread';
import { c, space } from '../design/tokens';
import { useI18n } from '../lib/i18n';
import { useNav } from '../nav/routes';
import { Button } from '../ui/Button';
import { Chips } from '../ui/Fields';
import { Card, LoadError, PageTitle, Row, Screen, Stack } from '../ui/Layout';
import { Badge, Skeleton, usePaged } from '../ui/Misc';
import { T } from '../ui/Text';

export default function InboxScreen() {
  return (
    <TabSignedIn>
      <Inbox />
    </TabSignedIn>
  );
}

function Inbox() {
  const { t } = useI18n();
  const f = useFormat();
  const qc = useQueryClient();
  const nav = useNav();
  const top = useTabTop();
  const text = useNotificationText();
  const unread = useUnread();
  const [scope, setScope] = useState<'all' | 'unread'>('all');
  const list = usePaged(['me', 'inbox', scope], (cursor) =>
    notificationsApi.list(scope === 'unread', cursor),
  );
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['me', 'inbox'] });
    void qc.invalidateQueries({ queryKey: ['me', 'unread'] });
  };
  const readAll = useMutation({ mutationFn: notificationsApi.readAll, onSuccess: refresh });
  const open = useMutation({
    mutationFn: (n: Notification) => (n.read ? Promise.resolve(null) : notificationsApi.read(n.id)),
    onSettled: refresh,
  });

  const go = (n: Notification, href: string | null) => {
    open.mutate(n);
    const target = href ? routeForPath(href) : null;
    if (target) goTo(nav, target);
  };

  const header = (
    <Stack style={styles.header}>
      <PageTitle>{t('inbox.title')}</PageTitle>
      <T color={c.inkSoft}>{t('inbox.lede')}</T>
      <Row>
        {unread > 0 ? (
          <Button
            kind="outline"
            small
            busy={readAll.isPending}
            label={t('inbox.readAll')}
            onPress={() => readAll.mutate()}
          />
        ) : null}
        <Button
          kind="link"
          small
          label={t('inbox.settings')}
          onPress={() => nav.navigate('NotificationSettings')}
        />
      </Row>
      <T v="small" color={c.inkSoft}>
        {unread === 1 ? t('inbox.unreadOne') : t('inbox.unread', { n: unread })}
      </T>
      <Chips
        label={t('inbox.show')}
        value={scope}
        onChange={(v) => setScope(v as 'all' | 'unread')}
        options={[
          { value: 'all', label: t('inbox.all') },
          { value: 'unread', label: t('inbox.unreadOnly') },
        ]}
      />
      {list.isPending ? <Skeleton rows={5} /> : null}
      {list.isError ? <LoadError onRetry={() => void list.refetch()} /> : null}
      {list.data && list.rows.length === 0 ? (
        <T color={c.inkSoft}>{t(scope === 'unread' ? 'inbox.emptyUnread' : 'inbox.empty')}</T>
      ) : null}
    </Stack>
  );

  return (
    <Screen scroll={false} bottomInset={false}>
      <FlatList
        data={list.rows}
        keyExtractor={(n) => n.id}
        contentContainerStyle={[styles.list, { paddingTop: top }]}
        ListHeaderComponent={header}
        ItemSeparatorComponent={Gap}
        refreshing={list.isRefetching && !list.isFetchingNextPage}
        onRefresh={refresh}
        onEndReachedThreshold={0.4}
        onEndReached={() => {
          if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
        }}
        renderItem={({ item: n }) => {
          const { text: line, href } = text(n);
          return (
            <Pressable accessibilityRole="button" onPress={() => go(n, href)}>
              <Card>
                {!n.read ? <Badge tone="good" label={t('inbox.new')} /> : null}
                <T v={n.read ? 'body' : 'bodyStrong'}>{line}</T>
                <T v="small" color={c.inkSoft}>
                  {f.relative(n.createdAt)}
                </T>
              </Card>
            </Pressable>
          );
        }}
      />
    </Screen>
  );
}

const Gap = () => <View style={styles.gap} />;

const styles = StyleSheet.create({
  list: { paddingHorizontal: space.gutter, paddingBottom: space.section },
  header: { marginBottom: space.gap },
  gap: { height: space.gap },
});
