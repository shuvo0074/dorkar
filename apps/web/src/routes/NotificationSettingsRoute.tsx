import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { AlertIcon, NoteIcon } from '../components/glyphs/glyphs';
import { LedgerSkeleton, LoadError, SignedInOnly } from '../components/ui/Status';
import {
  notificationsApi,
  type NotificationType,
  type Preference,
} from '../features/notifications/api';
import { errorMessage } from '../lib/errors';
import { useI18n, type MessageKey } from '../lib/i18n';

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

export default function NotificationSettingsRoute() {
  return (
    <SignedInOnly from="/account/notifications">
      <Loader />
    </SignedInOnly>
  );
}

function Loader() {
  const prefs = useQuery({
    queryKey: ['me', 'notification-prefs'],
    queryFn: notificationsApi.preferences,
  });
  if (prefs.isPending) return <LedgerSkeleton rows={6} />;
  if (prefs.isError) return <LoadError onRetry={() => void prefs.refetch()} />;
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
    <div className="browse">
      <header className="desk__head">
        <p className="crumb">
          <Link to="/account">{t('account.title')}</Link>
        </p>
        <h1 tabIndex={-1}>{t('prefs.title')}</h1>
        <p className="desk__lede">{t('prefs.lede')}</p>
      </header>

      {GROUPS.map((g) => {
        const rows = g.types.filter((type) => prefs.has(type));
        if (rows.length === 0) return null;
        return (
          <section key={g.key} aria-labelledby={g.key}>
            <table className="figures prefs">
              <caption className="section-head">
                <h2 id={g.key}>{t(g.key)}</h2>
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t('prefs.type')}</th>
                  {CHANNELS.map((c) => (
                    <th key={c} scope="col">
                      {t(`prefs.${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((type) => {
                  const p = prefs.get(type)!;
                  const name = t(`notetype.${type}`);
                  return (
                    <tr key={type}>
                      <th scope="row">{name}</th>
                      {CHANNELS.map((c) => (
                        <td key={c}>
                          <label className="check prefs__check">
                            <input
                              type="checkbox"
                              checked={p[c]}
                              aria-label={`${name}: ${t(`prefs.${c}`)}`}
                              onChange={() => toggle(type, c)}
                            />
                            <span />
                          </label>
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        );
      })}

      <div className="formactions prefs__save">
        <button
          type="button"
          className="btn"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? t('common.saving') : t('prefs.save')}
        </button>
        {save.isSuccess && (
          <p className="alert alert--note" role="status">
            <NoteIcon />
            <span>{t('prefs.saved')}</span>
          </p>
        )}
        {save.isError && (
          <p className="alert" role="alert">
            <AlertIcon />
            <span>{errorMessage(save.error, t)}</span>
          </p>
        )}
      </div>
    </div>
  );
}
