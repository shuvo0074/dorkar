import { accountApi } from '@web/features/account/api';
import { useCan } from '@web/features/auth/permissions';
import type { Permission } from '@dorkar/contracts/authz';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { BlockedPeople, MyReports } from '../features/account/Safety';
import { TabSignedIn, useTabTop } from '../features/account/TabPage';
import { useSession } from '../features/auth/session';
import { c } from '../design/tokens';
import { errorMessage } from '../lib/errors';
import { useI18n } from '../lib/i18n';
import { useNav } from '../nav/routes';
import { Button } from '../ui/Button';
import {
  Alert,
  Card,
  Divider,
  LoadError,
  PageTitle,
  Row,
  Screen,
  Section,
  Stack,
} from '../ui/Layout';
import { Badge, Fact, Skeleton } from '../ui/Misc';
import { T } from '../ui/Text';

/** What opens the staff desk on the website; the desk itself isn't in the app. */
const STAFF_PERMISSIONS: Permission[] = [
  'dashboard:read',
  'moderation:case:read',
  'dispute:read',
  'verification:nid:decide',
  'user:suspend',
  'category:manage',
  'policy:read',
  'auction:manage',
  'transaction:read:any',
  'audit:read',
];

export default function AccountScreen() {
  return (
    <TabSignedIn>
      <Account />
    </TabSignedIn>
  );
}

function Account() {
  const { t, date } = useI18n();
  const session = useSession();
  const nav = useNav();
  const top = useTabTop();
  const can = useCan();
  const a = session.account!;
  const memberCode = `M-${a.id.replace(/-/g, '').slice(-6).toUpperCase()}`;

  return (
    <Screen bottomInset={false} contentStyle={{ paddingTop: top }}>
      <PageTitle>{t('account.title')}</PageTitle>

      <Card>
        <Fact label={t('account.member')}>{memberCode}</Fact>
        <Fact label={t('account.phone')}>{a.phoneMasked}</Fact>
        <Fact label={t('account.status')}>{t(`account.status.${a.status}`)}</Fact>
        <Fact label={t('account.joined')}>{date(a.createdAt, 'short')}</Fact>
      </Card>

      <Row>
        <Button
          kind="outline"
          small
          label={t('me.title')}
          onPress={() => nav.navigate('ProfileSettings')}
        />
        <Button
          kind="outline"
          small
          label={t('prefs.title')}
          onPress={() => nav.navigate('NotificationSettings')}
        />
      </Row>

      {STAFF_PERMISSIONS.some((p) => can(p)) ? (
        <Alert tone="info" message={t('desk.useWeb')} />
      ) : null}

      <Devices />
      <Sessions />
      <BlockedPeople />
      <MyReports />

      <Button
        block
        kind="outline"
        label={t('account.signOut')}
        onPress={() => {
          // Leave first: once the session ends this page would ask for sign-in instead.
          nav.navigate('Tabs', { screen: 'Home' });
          void session.signOut('this').catch(() => undefined);
        }}
      />

      <SignOutEverywhere />
    </Screen>
  );
}

function Devices() {
  const { t, date } = useI18n();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState<string | null>(null);
  const devices = useQuery({ queryKey: ['me', 'devices'], queryFn: accountApi.devices });
  const revoke = useMutation({
    mutationFn: accountApi.revokeDevice,
    onSuccess: () => {
      setConfirming(null);
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });

  return (
    <Section title={t('devices.title')}>
      {devices.isPending ? <Skeleton /> : null}
      {devices.isError ? (
        <LoadError message={t('account.error')} onRetry={() => void devices.refetch()} />
      ) : null}
      {devices.data && devices.data.length === 0 ? (
        <T color={c.inkSoft}>{t('devices.empty')}</T>
      ) : null}
      {devices.data?.map((d) => {
        const name = d.label ?? d.platform;
        return (
          <Card key={d.id}>
            <Row>
              <T v="bodyStrong" style={styles.shrink}>
                {name}
              </T>
              {d.current ? <Badge tone="good" label={t('devices.current')} /> : null}
            </Row>
            <T v="small" color={c.inkSoft}>
              {t(`devices.trust.${d.trust}`)} · {t('devices.lastSeen')} {date(d.lastSeenAt)}
            </T>
            {!d.current && confirming !== d.id ? (
              <Button
                kind="danger"
                small
                label={t('devices.revoke')}
                onPress={() => setConfirming(d.id)}
              />
            ) : null}
            {confirming === d.id ? (
              <View style={styles.confirm} accessibilityLabel={t('devices.revoke')}>
                <T>{t('devices.confirm', { name })}</T>
                <Row>
                  <Button
                    kind="danger"
                    small
                    busy={revoke.isPending}
                    label={t('devices.confirmYes')}
                    onPress={() => revoke.mutate(d.id)}
                  />
                  <Button
                    kind="outline"
                    small
                    label={t('devices.cancel')}
                    onPress={() => setConfirming(null)}
                  />
                </Row>
                {revoke.isError ? <Alert message={errorMessage(revoke.error, t)} /> : null}
              </View>
            ) : null}
          </Card>
        );
      })}
    </Section>
  );
}

function Sessions() {
  const { t, date } = useI18n();
  const sessions = useQuery({ queryKey: ['me', 'sessions'], queryFn: accountApi.sessions });

  return (
    <Section title={t('sessions.title')}>
      {sessions.isPending ? <Skeleton /> : null}
      {sessions.isError ? (
        <LoadError message={t('account.error')} onRetry={() => void sessions.refetch()} />
      ) : null}
      {sessions.data ? (
        <Card>
          {sessions.data.map((s, i) => (
            <Stack key={s.id}>
              {i > 0 ? <Divider /> : null}
              <Row>
                <T v="bodyStrong" style={styles.shrink}>
                  {t('sessions.started')} {date(s.createdAt)}
                </T>
                {s.current ? <Badge tone="good" label={t('sessions.current')} /> : null}
              </Row>
              <T v="small" color={c.inkSoft}>
                {t('sessions.refreshed')} {date(s.lastRefreshedAt ?? s.createdAt)} ·{' '}
                {t('sessions.expires')} {date(s.expiresAt, 'short')}
              </T>
            </Stack>
          ))}
        </Card>
      ) : null}
    </Section>
  );
}

function SignOutEverywhere() {
  const { t } = useI18n();
  const { signOut } = useSession();
  const nav = useNav();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <Stack>
      <T color={c.inkSoft}>{t('account.signOutAllHelp')}</T>
      {!confirm ? (
        <Button
          block
          kind="danger"
          label={t('account.signOutAll')}
          onPress={() => setConfirm(true)}
        />
      ) : (
        <View style={styles.confirm} accessibilityLabel={t('account.signOutAll')}>
          <T>{t('account.signOutAllConfirm')}</T>
          <Row>
            <Button
              kind="danger"
              small
              busy={busy}
              label={t('account.signOutAll')}
              onPress={() => {
                setBusy(true);
                nav.navigate('Tabs', { screen: 'Home' });
                void signOut('all').catch(() => undefined);
              }}
            />
            <Button
              kind="outline"
              small
              label={t('devices.cancel')}
              onPress={() => setConfirm(false)}
            />
          </Row>
        </View>
      )}
    </Stack>
  );
}

const styles = StyleSheet.create({
  shrink: { flexShrink: 1 },
  confirm: { gap: 10 },
});
