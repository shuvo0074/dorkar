import {
  notificationsApi,
  type NotificationType,
  type Preference,
} from '@web/features/notifications/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { c } from '../design/tokens';
import { errorMessage } from '../lib/errors';
import { useI18n, type MessageKey } from '../lib/i18n';
import { SignedInOnly } from '../nav/SignedInOnly';
import { Button } from '../ui/Button';
import { Chips } from '../ui/Fields';
import { Alert, Card, LoadError, Screen, Section, Stack } from '../ui/Layout';
import { Skeleton } from '../ui/Misc';
import { T } from '../ui/Text';

const GROUPS: Array<{ key: MessageKey; types: NotificationType[] }> = [
  {
    key: 'prefs.group.needs',
    types: [
      'NEED_MATCHED',
      'OFFER_RECEIVED',
      'OFFER_COUNTERED',
      'OFFER_ACCEPTED',
      'OFFER_REJECTED',
      'OFFER_CLOSED',
      'NEED_EXPIRED',
      'NEED_FULFILLING',
    ],
  },
  {
    key: 'prefs.group.deals',
    types: ['TRANSACTION_CREATED', 'TRANSACTION_UPDATED', 'REVIEW_RECEIVED'],
  },
  {
    key: 'prefs.group.auctions',
    types: [
      'BID_PLACED',
      'BID_OUTBID',
      'AUCTION_CLOSED',
      'AUCTION_WON',
      'AUCTION_LOST',
      'AUCTION_CANCELLED',
    ],
  },
  {
    key: 'prefs.group.rentals',
    types: [
      'BOOKING_REQUESTED',
      'BOOKING_CONFIRMED',
      'BOOKING_DECLINED',
      'BOOKING_EXPIRED',
      'BOOKING_CANCELLED',
      'BOOKING_OVERDUE',
      'LOAN_REQUESTED',
      'LOAN_APPROVED',
      'LOAN_DECLINED',
      'LOAN_EXPIRED',
      'LOAN_OVERDUE',
    ],
  },
  {
    key: 'prefs.group.other',
    types: [
      'DISPUTE_OPENED',
      'DISPUTE_UPDATED',
      'DISPUTE_RESOLVED',
      'DISPUTE_WITHDRAWN',
      'NEW_MESSAGE',
      'VERIFICATION_UPDATED',
    ],
  },
];

const CHANNELS = ['inApp', 'sms', 'push'] as const;

export default function NotificationSettingsScreen() {
  return (
    <SignedInOnly>
      <Loader />
    </SignedInOnly>
  );
}

function Loader() {
  const prefs = useQuery({
    queryKey: ['me', 'notification-prefs'],
    queryFn: notificationsApi.preferences,
  });
  if (prefs.isPending)
    return (
      <Screen>
        <Skeleton rows={6} />
      </Screen>
    );
  if (prefs.isError)
    return (
      <Screen>
        <LoadError onRetry={() => void prefs.refetch()} />
      </Screen>
    );
  return <Settings initial={prefs.data} />;
}

function Settings({ initial }: { initial: Preference[] }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [prefs, setPrefs] = useState(() => new Map(initial.map((p) => [p.type, p])));
  const save = useMutation({
    mutationFn: () => notificationsApi.savePreferences([...prefs.values()]),
    onSuccess: (saved) => qc.setQueryData(['me', 'notification-prefs'], saved),
  });
  const toggle = (type: NotificationType, ch: (typeof CHANNELS)[number]) =>
    setPrefs((m) => {
      const next = new Map(m);
      const p = next.get(type);
      if (p) next.set(type, { ...p, [ch]: !p[ch] });
      return next;
    });

  return (
    <Screen
      footer={
        <Stack>
          {save.isSuccess ? <Alert tone="info" message={t('prefs.saved')} /> : null}
          {save.isError ? <Alert message={errorMessage(save.error, t)} /> : null}
          <Button
            block
            busy={save.isPending}
            label={save.isPending ? t('common.saving') : t('prefs.save')}
            onPress={() => save.mutate()}
          />
        </Stack>
      }
    >
      <T color={c.inkSoft}>{t('prefs.lede')}</T>
      {GROUPS.map((g) => {
        const rows = g.types.filter((type) => prefs.has(type));
        if (rows.length === 0) return null;
        return (
          <Section key={g.key} title={t(g.key)}>
            {rows.map((type) => {
              const p = prefs.get(type)!;
              const name = t(`notetype.${type}`);
              return (
                <Card key={type}>
                  <T v="bodyStrong">{name}</T>
                  <Chips
                    label={name}
                    value={CHANNELS.filter((ch) => p[ch])}
                    onChange={(ch) => toggle(type, ch as (typeof CHANNELS)[number])}
                    options={CHANNELS.map((ch) => ({ value: ch, label: t(`prefs.${ch}`) }))}
                  />
                </Card>
              );
            })}
          </Section>
        );
      })}
    </Screen>
  );
}
