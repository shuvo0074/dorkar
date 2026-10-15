import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Segmented } from '../components/forms/fields';
import { MoreButton, usePaged } from '../components/ui/Paging';
import { LedgerSkeleton, LoadError, SignedInOnly } from '../components/ui/Status';
import { notificationsApi, type Notification } from '../features/notifications/api';
import { useNotificationText } from '../features/notifications/text';
import { useUnread } from '../features/notifications/useUnread';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';

export default function InboxRoute() {
  return (
    <SignedInOnly from="/inbox">
      <Inbox />
    </SignedInOnly>
  );
}

function Inbox() {
  const { t } = useI18n();
  const f = useFormat();
  const qc = useQueryClient();
  const navigate = useNavigate();
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
    if (href) void navigate(href);
  };

  return (
    <div className="browse">
      <header className="desk__head">
        <h1 tabIndex={-1}>{t('inbox.title')}</h1>
        <p className="desk__lede">{t('inbox.lede')}</p>
        <div className="desk__meta">
          {unread > 0 && (
            <button
              type="button"
              className="btn btn--outline btn--small"
              disabled={readAll.isPending}
              onClick={() => readAll.mutate()}
            >
              {t('inbox.readAll')}
            </button>
          )}
          <Link to="/account/notifications">{t('inbox.settings')}</Link>
        </div>
      </header>

      <section aria-labelledby="inbox-list">
        <div className="section-head">
          <h2 id="inbox-list">{t('inbox.title')}</h2>
          <p>{unread === 1 ? t('inbox.unreadOne') : t('inbox.unread', { n: unread })}</p>
        </div>
        <Segmented
          legend={t('inbox.show')}
          hideLegend
          name="inbox-scope"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'all', label: t('inbox.all') },
            { value: 'unread', label: t('inbox.unreadOnly') },
          ]}
        />
        {list.isPending && <LedgerSkeleton rows={5} />}
        {list.isError && <LoadError onRetry={() => void list.refetch()} />}
        {list.data && list.rows.length === 0 && (
          <p className="muted">{t(scope === 'unread' ? 'inbox.emptyUnread' : 'inbox.empty')}</p>
        )}
        {list.rows.length > 0 && (
          <ol className="inbox">
            {list.rows.map((n) => {
              const { text: line, href } = text(n);
              return (
                <li key={n.id} data-unread={n.read ? undefined : ''}>
                  <button type="button" className="inbox__row" onClick={() => go(n, href)}>
                    <span className="inbox__text">
                      {!n.read && <span className="stamp stamp--ink">{t('inbox.new')}</span>} {line}
                    </span>
                    <time className="muted" dateTime={n.createdAt}>
                      {f.relative(n.createdAt)}
                    </time>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        <MoreButton query={list} />
      </section>
    </div>
  );
}
