import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MoreButton, usePaged } from '../../components/ui/Paging';
import { LedgerSkeleton } from '../../components/ui/Status';
import { targetLink } from '../desk/tools';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { Link } from 'react-router';
import { chatApi } from '../messages/api';
import { trustApi } from '../trust/api';
import { UserLink } from '../trust/UserLink';

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
    <section aria-labelledby="blocked-title">
      <div className="section-head">
        <h2 id="blocked-title">{t('blocked.title')}</h2>
      </div>
      {list.isPending && <LedgerSkeleton />}
      {list.data && list.rows.length === 0 && <p className="muted">{t('blocked.empty')}</p>}
      {list.rows.length > 0 && (
        <ul className="statelist">
          {list.rows.map((b) => (
            <li key={b.userId}>
              <span>
                <UserLink userId={b.userId} />
                <span className="muted">
                  {' '}
                  · {t('blocked.since', { when: date(b.blockedAt, 'short') })}
                </span>
              </span>
              <button
                type="button"
                className="linkbtn"
                disabled={unblock.isPending}
                onClick={() => unblock.mutate(b.userId)}
              >
                {t('chat.unblock')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <MoreButton query={list} />
    </section>
  );
}

/** What the member reported and what became of it. */
export function MyReports() {
  const { t } = useI18n();
  const f = useFormat();
  const list = usePaged(['me', 'reports'], (cursor) => trustApi.myReports(cursor));
  return (
    <section aria-labelledby="reports-title">
      <div className="section-head">
        <h2 id="reports-title">{t('reports.title')}</h2>
      </div>
      {list.isPending && <LedgerSkeleton />}
      {list.data && list.rows.length === 0 && <p className="muted">{t('reports.empty')}</p>}
      {list.rows.length > 0 && (
        <ul className="statelist">
          {list.rows.map((r) => {
            const href = targetLink(r.targetType, r.targetId);
            return (
              <li key={r.id}>
                <span>
                  {href ? (
                    <Link to={href}>{t(`target.${r.targetType}`)}</Link>
                  ) : (
                    t(`target.${r.targetType}`)
                  )}
                  <span className="muted">
                    {' '}
                    · {t(`report.reason.${r.reason}`)} · {f.relative(r.createdAt)}
                  </span>
                </span>
                <span className="code">{t(`reports.status.${r.status}`)}</span>
              </li>
            );
          })}
        </ul>
      )}
      <MoreButton query={list} />
    </section>
  );
}
