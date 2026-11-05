import { findContactInfo } from '@dorkar/contracts';
import { chatApi, type Conversation, type Message } from '@web/features/messages/api';
import { useThread, type Outgoing } from '@web/features/messages/useThread';
import { shortCode } from '@web/lib/format';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FlatList, StyleSheet, TextInput, View } from 'react-native';
import { NotFound } from '../features/account/NotFound';
import { useSession } from '../features/auth/session';
import { contextLink } from '../features/messages/MessageButton';
import { goTo } from '../features/notifications/links';
import { useProfile } from '../features/trust/UserLink';
import { c, fontFor, r, size, space, keyboardAppearance } from '../design/tokens';
import { errorMessage, ruleOf } from '../lib/errors';
import { ApiError } from '../lib/http';
import { useI18n } from '../lib/i18n';
import { useNav, useParams } from '../nav/routes';
import { SignedInOnly } from '../nav/SignedInOnly';
import { Button, LinkText } from '../ui/Button';
import { SendIcon } from '../ui/icons';
import { Alert, LoadError, Row, Screen, Stack } from '../ui/Layout';
import { Skeleton } from '../ui/Misc';
import { Pressy } from '../ui/Pressy';
import { T } from '../ui/Text';

export default function ConversationScreen() {
  const { id } = useParams<'Conversation'>()!;
  return (
    <SignedInOnly>
      <Loader id={id} />
    </SignedInOnly>
  );
}

function Loader({ id }: { id: string }) {
  const convo = useQuery({ queryKey: ['me', 'conversations', id], queryFn: () => chatApi.get(id) });
  // The thread loads its history once when it mounts: a retry starts it afresh.
  const [attempt, setAttempt] = useState(0);
  if (convo.isPending)
    return (
      <Screen>
        <Skeleton rows={5} />
      </Screen>
    );
  if (convo.error instanceof ApiError && convo.error.status === 404) return <NotFound />;
  if (convo.isError)
    return (
      <Screen>
        <LoadError onRetry={() => void convo.refetch()} />
      </Screen>
    );
  return <Thread key={attempt} convo={convo.data} onRetry={() => setAttempt((a) => a + 1)} />;
}

function sendProblem(err: unknown, t: ReturnType<typeof useI18n>['t']) {
  if (ruleOf(err) === 'CONTACT_INFO_NOT_ALLOWED') return t('chat.contact');
  if (err instanceof ApiError && err.code === 'FORBIDDEN') return t('chat.blocked');
  return errorMessage(err, t);
}

type Line =
  | { key: string; message: Message; outgoing?: never }
  | { key: string; outgoing: Outgoing; message?: never };

function Thread({ convo, onRetry }: { convo: Conversation; onRetry: () => void }) {
  const { t, lang } = useI18n();
  const nav = useNav();
  const me = useSession().account?.id;
  const qc = useQueryClient();
  const other = useProfile(convo.otherParticipantId);
  const thread = useThread(convo.id);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string>();
  const [pageTop, setPageTop] = useState(0);
  const page = useRef<React.ComponentRef<typeof View>>(null);
  const name =
    other.data?.displayName ??
    t('common.member', { code: shortCode('M', convo.otherParticipantId) });

  useLayoutEffect(() => nav.setOptions({ title: t('chat.with', { name }) }), [nav, t, name]);

  const last = thread.messages.at(-1);
  // Mark read once the newest message is someone else's and on screen.
  useEffect(() => {
    if (!last || last.senderId === me) return;
    void chatApi.read(convo.id, last.id).then(() => {
      void qc.invalidateQueries({ queryKey: ['me', 'unread'] });
      void qc.invalidateQueries({ queryKey: ['me', 'conversations'], exact: false });
    });
  }, [last, me, convo.id, qc]);

  const failed = thread.outgoing.find((o) => o.status === 'failed');
  useEffect(() => {
    if (failed) setProblem(sendProblem(failed.error, t));
  }, [failed, t]);

  const submit = () => {
    const body = draft.trim();
    if (!body) return;
    if (findContactInfo(body)) return setProblem(t('chat.contact'));
    setProblem(undefined);
    setDraft('');
    void thread.send(body);
  };

  // Newest first: the list is inverted, so the newest sits at the bottom, by the composer.
  const lines = useMemo<Line[]>(
    () => [
      ...[...thread.outgoing].reverse().map((o) => ({ key: o.clientId, outgoing: o })),
      ...[...thread.messages].reverse().map((m) => ({ key: m.id, message: m })),
    ],
    [thread.messages, thread.outgoing],
  );
  const canSend = draft.trim().length > 0;

  return (
    <View
      ref={page}
      style={styles.flex}
      onLayout={() => page.current?.measureInWindow((_x: number, y: number) => setPageTop(y))}
    >
      <Screen
        scroll={false}
        keyboardOffset={pageTop}
        footer={
          <Stack gap={8}>
            {problem ? <Alert message={problem} /> : null}
            <T v="small" color={c.inkSoft}>
              {t('chat.writeHint')}
            </T>
            <View style={styles.compose}>
              <TextInput
                keyboardAppearance={keyboardAppearance}
                accessibilityLabel={t('chat.write')}
                placeholder={t('chat.write')}
                placeholderTextColor={c.placeholder}
                selectionColor={c.accent}
                value={draft}
                onChangeText={(v) => {
                  setDraft(v);
                  if (problem) setProblem(undefined);
                }}
                maxLength={2000}
                multiline
                textAlignVertical="center"
                style={[styles.input, { fontFamily: fontFor(lang, 500) }]}
              />
              <Pressy
                accessibilityLabel={t('chat.send')}
                accessibilityState={{ disabled: !canSend }}
                onPress={canSend ? submit : undefined}
                style={[styles.send, !canSend && styles.off]}
              >
                <SendIcon color={c.primaryFg} size={22} />
              </Pressy>
            </View>
          </Stack>
        }
      >
        <Stack gap={4} style={styles.context}>
          <Row style={styles.contextLinks}>
            <T v="small" color={c.inkSoft}>
              {t(`chat.about.${convo.context.type}`)}
            </T>
            <LinkText
              label={t('chat.open')}
              onPress={() => goTo(nav, contextLink(convo.context.type, convo.context.id))}
            />
            <LinkText
              label={t('profile.view')}
              onPress={() => nav.navigate('User', { id: convo.otherParticipantId })}
            />
          </Row>
          <Block userId={convo.otherParticipantId} />
        </Stack>
        {thread.loadError ? (
          <View style={styles.pad}>
            <LoadError onRetry={onRetry} />
          </View>
        ) : !thread.loaded ? (
          <View style={styles.pad}>
            <Skeleton rows={4} />
          </View>
        ) : (
          <FlatList
            inverted
            style={styles.flex}
            data={lines}
            keyExtractor={(l) => l.key}
            contentContainerStyle={styles.log}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={
              <T color={c.inkSoft} align="center">
                {t('chat.noMessages')}
              </T>
            }
            ListFooterComponent={
              thread.older ? (
                <Button
                  kind="link"
                  small
                  label={t('chat.older')}
                  onPress={() => void thread.loadOlder()}
                />
              ) : undefined
            }
            renderItem={({ item }) =>
              item.message ? (
                <Bubble message={item.message} mine={item.message.senderId === me} name={name} />
              ) : (
                <Pending
                  outgoing={item.outgoing}
                  onRetry={() => void thread.send(item.outgoing.body, item.outgoing.clientId)}
                />
              )
            }
          />
        )}
      </Screen>
    </View>
  );
}

function Bubble({ message: m, mine, name }: { message: Message; mine: boolean; name: string }) {
  const { t, date } = useI18n();
  const fg = mine ? c.chatMineFg : c.chatTheirsFg;
  return (
    <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
      <T v="code" color={fg} style={styles.who}>
        {mine ? t('chat.you') : name} · {date(m.createdAt)}
      </T>
      <T color={fg} style={m.removed ? styles.who : null}>
        {m.removed ? t('chat.removed') : m.body}
      </T>
    </View>
  );
}

function Pending({ outgoing: o, onRetry }: { outgoing: Outgoing; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <View style={styles.pending}>
      <View style={[styles.bubble, styles.mine, styles.sending]}>
        <T v="code" color={c.chatMineFg} style={styles.who}>
          {t('chat.you')}
          {o.status === 'sending' ? ` · ${t('chat.sending')}` : ''}
        </T>
        <T color={c.chatMineFg}>{o.body}</T>
      </View>
      {o.status === 'failed' ? (
        <Button kind="link" small label={t('chat.failed')} onPress={onRetry} />
      ) : null}
    </View>
  );
}

function Block({ userId }: { userId: string }) {
  const { t } = useI18n();
  const [confirm, setConfirm] = useState(false);
  const block = useMutation({ mutationFn: () => chatApi.block(userId) });
  if (block.isSuccess) return <Alert tone="info" message={t('chat.blockedDone')} />;
  if (!confirm)
    return <Button kind="link" small label={t('chat.block')} onPress={() => setConfirm(true)} />;
  return (
    <Stack gap={8}>
      <T v="small">{t('chat.blockConfirm')}</T>
      <Row>
        <Button
          kind="danger"
          small
          busy={block.isPending}
          label={t('chat.blockYes')}
          onPress={() => block.mutate()}
        />
        <Button kind="outline" small label={t('common.keep')} onPress={() => setConfirm(false)} />
      </Row>
    </Stack>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pad: { flex: 1, padding: space.gutter },
  context: {
    paddingHorizontal: space.gutter,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.line,
  },
  contextLinks: { gap: 12 },
  log: { padding: space.gutter, gap: 8, flexGrow: 1 },
  bubble: {
    maxWidth: '85%',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: r.tile,
    gap: 2,
  },
  mine: { alignSelf: 'flex-end', backgroundColor: c.chatMineBg },
  theirs: { alignSelf: 'flex-start', backgroundColor: c.chatTheirsBg },
  who: { opacity: 0.75 },
  pending: { alignItems: 'flex-end' },
  sending: { opacity: 0.7 },
  compose: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: {
    flex: 1,
    minHeight: size.small,
    maxHeight: 120,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: r.control,
    borderWidth: 1.5,
    borderColor: c.lineStrong,
    backgroundColor: c.field,
    color: c.ink,
    fontSize: 16,
  },
  send: {
    width: size.small,
    height: size.small,
    borderRadius: r.control,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.primaryBg,
  },
  off: { opacity: 0.45 },
});
