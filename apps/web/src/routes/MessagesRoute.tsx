import { Link } from 'react-router';
import { MoreButton, usePaged } from '../components/ui/Paging';
import { LedgerSkeleton, LoadError, SignedInOnly } from '../components/ui/Status';
import { useSession } from '../features/auth/session';
import { chatApi, type Conversation } from '../features/messages/api';
import { useProfile } from '../features/trust/UserLink';
import { shortCode, useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';

export default function MessagesRoute() {
  return (
    <SignedInOnly from="/messages">
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
    <div className="browse">
      <header className="desk__head">
        <h1 tabIndex={-1}>{t('chat.title')}</h1>
        <p className="desk__lede">{t('chat.lede')}</p>
      </header>
      <section aria-labelledby="convos-title">
        <div className="section-head">
          <h2 id="convos-title">{t('chat.title')}</h2>
        </div>
        {list.isPending && <LedgerSkeleton rows={4} />}
        {list.isError && <LoadError onRetry={() => void list.refetch()} />}
        {list.data && list.rows.length === 0 && <p className="muted">{t('chat.empty')}</p>}
        {list.rows.length > 0 && (
          <ul className="ledger">
            {list.rows.map((c) => (
              <Row key={c.id} c={c} />
            ))}
          </ul>
        )}
        <MoreButton query={list} />
      </section>
    </div>
  );
}

function Row({ c }: { c: Conversation }) {
  const { t, num } = useI18n();
  const f = useFormat();
  const me = useSession().account?.id;
  const other = useProfile(c.otherParticipantId);
  const name =
    other.data?.displayName ?? t('common.member', { code: shortCode('M', c.otherParticipantId) });
  const preview = c.lastMessage
    ? c.lastMessage.removed
      ? t('chat.removed')
      : `${c.lastMessage.senderId === me ? `${t('chat.you')}: ` : ''}${c.lastMessage.preview ?? ''}`
    : t('chat.noMessages');
  return (
    <li data-unread={c.unreadCount > 0 ? '' : undefined}>
      <span className="ledger__art code">{c.unreadCount > 0 ? num(c.unreadCount) : '—'}</span>
      <div>
        <Link className="ledger__title" to={`/messages/${c.id}`}>
          {name}
        </Link>
        <p className="ledger__meta">
          {[t(`chat.about.${c.context.type}`), c.lastMessageAt && f.relative(c.lastMessageAt)]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <p className="chat__preview">{preview}</p>
      </div>
      {c.unreadCount > 0 && (
        <span className="stamp stamp--ink">{t('chat.unread', { n: c.unreadCount })}</span>
      )}
    </li>
  );
}
