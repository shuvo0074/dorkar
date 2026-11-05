import { chatApi, type Conversation } from '@web/features/messages/api';
import { shortCode, useFormat } from '@web/lib/format';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useSession } from '../features/auth/session';
import { useProfile } from '../features/trust/UserLink';
import { c, space } from '../design/tokens';
import { useI18n } from '../lib/i18n';
import { useNav } from '../nav/routes';
import { SignedInOnly } from '../nav/SignedInOnly';
import { Card, LoadError, Row as Line, Screen, Stack } from '../ui/Layout';
import { Badge, Skeleton, usePaged } from '../ui/Misc';
import { T } from '../ui/Text';

export default function MessagesScreen() {
  return (
    <SignedInOnly>
      <Conversations />
    </SignedInOnly>
  );
}

function Conversations() {
  const { t } = useI18n();
  const list = usePaged(['me', 'conversations', 'list'], (cursor) => chatApi.list(cursor), {
    refetchInterval: 30_000,
  });
  return (
    <Screen scroll={false}>
      <FlatList
        data={list.rows}
        keyExtractor={(x) => x.id}
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
            <T color={c.inkSoft}>{t('chat.lede')}</T>
            {list.isPending ? <Skeleton rows={4} /> : null}
            {list.isError ? <LoadError onRetry={() => void list.refetch()} /> : null}
            {list.data && list.rows.length === 0 ? (
              <T color={c.inkSoft}>{t('chat.empty')}</T>
            ) : null}
          </Stack>
        }
        renderItem={({ item }) => <Row convo={item} />}
      />
    </Screen>
  );
}

function Row({ convo }: { convo: Conversation }) {
  const { t } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const me = useSession().account?.id;
  const other = useProfile(convo.otherParticipantId);
  const name =
    other.data?.displayName ??
    t('common.member', { code: shortCode('M', convo.otherParticipantId) });
  const last = convo.lastMessage;
  const preview = last
    ? last.removed
      ? t('chat.removed')
      : `${last.senderId === me ? `${t('chat.you')}: ` : ''}${last.preview ?? ''}`
    : t('chat.noMessages');
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => nav.navigate('Conversation', { id: convo.id })}
    >
      <Card>
        <Line style={styles.top}>
          <T v="bodyStrong" numberOfLines={1} style={styles.name}>
            {name}
          </T>
          {convo.unreadCount > 0 ? (
            <Badge tone="good" label={t('chat.unread', { n: convo.unreadCount })} />
          ) : null}
        </Line>
        <T v="small" color={c.inkSoft}>
          {[
            t(`chat.about.${convo.context.type}`),
            convo.lastMessageAt && f.relative(convo.lastMessageAt),
          ]
            .filter(Boolean)
            .join(' · ')}
        </T>
        <T numberOfLines={2}>{preview}</T>
      </Card>
    </Pressable>
  );
}

const Gap = () => <View style={styles.gap} />;

const styles = StyleSheet.create({
  list: { padding: space.gutter },
  header: { marginBottom: space.gap },
  gap: { height: space.gap },
  top: { flexWrap: 'nowrap', justifyContent: 'space-between' },
  name: { flexShrink: 1 },
});
