import { Link } from 'react-router';
import { MoreButton, usePaged } from '../../components/ui/Paging';
import { LedgerSkeleton } from '../../components/ui/Status';
import { useI18n } from '../../lib/i18n';
import { UserLink } from '../trust/UserLink';
import { needsApi } from './api';

/** For the need's owner: who Dorkar told about it, and how well each matched. */
export function Matches({ needId }: { needId: string }) {
  const { t, num } = useI18n();
  const list = usePaged(['needs', needId, 'matches'], (cursor) => needsApi.matches(needId, cursor));
  if (list.isError) return null;
  return (
    <section className="item__wide" aria-labelledby="matches-title">
      <div className="section-head">
        <h2 id="matches-title">{t('matches.title')}</h2>
        <p>{t('matches.note')}</p>
      </div>
      {list.isPending && <LedgerSkeleton rows={2} />}
      {list.data && list.rows.length === 0 && <p className="muted">{t('matches.empty')}</p>}
      {list.rows.length > 0 && (
        <ul className="statelist">
          {list.rows
            .filter((m) => m.status !== 'DISMISSED')
            .map((m) => (
              <li key={m.matchId}>
                <span>
                  <UserLink userId={m.sellerId} />
                  {m.listingId && (
                    <>
                      {' · '}
                      <Link to={`/listings/${m.listingId}`}>{t('matches.listing')}</Link>
                    </>
                  )}
                  {m.status === 'RESPONDED' && (
                    <span className="muted"> · {t('matches.responded')}</span>
                  )}
                </span>
                <span className="code">{t('matches.score', { n: num(Math.round(m.score)) })}</span>
              </li>
            ))}
        </ul>
      )}
      <MoreButton query={list} />
    </section>
  );
}
