import { useParams } from 'react-router';
import { PersonGlyph } from '../components/glyphs/glyphs';
import { Biro } from '../components/ui/Biro';
import { MoreButton, usePaged } from '../components/ui/Paging';
import { LedgerSkeleton, LoadError } from '../components/ui/Status';
import { useCategories } from '../features/catalog/categories';
import { trustApi, type PublicProfile } from '../features/trust/api';
import { Rating, ReviewItem } from '../features/trust/DealReviews';
import { useProfile } from '../features/trust/UserLink';
import { ApiError } from '../lib/http';
import { shortCode, useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';
import NotFoundRoute from './NotFoundRoute';

export default function UserRoute() {
  const { id = '' } = useParams();
  const profile = useProfile(id);
  if (profile.isPending) return <LedgerSkeleton rows={5} />;
  if (profile.error instanceof ApiError && profile.error.status === 404) return <NotFoundRoute />;
  if (profile.isError) return <LoadError onRetry={() => void profile.refetch()} />;
  return <Profile p={profile.data} />;
}

function Profile({ p }: { p: PublicProfile }) {
  const { t, num, date } = useI18n();
  const f = useFormat();
  const categories = useCategories();
  const rep = p.reputation;
  const verified = p.badges.length > 0;

  return (
    <article className="account profile">
      <header>
        <h1 tabIndex={-1}>{p.displayName}</h1>
        {p.bio && <p className="desk__lede profile__bio">{p.bio}</p>}
      </header>

      <section className="member" aria-label={p.displayName}>
        <div className="member__badge">
          <PersonGlyph />
          {verified && <Biro tilt={-6} />}
        </div>
        <dl>
          <dt>{t('account.member')}</dt>
          <dd className="code">{shortCode('M', p.id)}</dd>
          <dt>{t('account.joined')}</dt>
          <dd>{date(p.memberSince, 'short')}</dd>
          <dt>{t('profile.type')}</dt>
          <dd>{t(p.userType === 'BUSINESS' ? 'profile.business' : 'profile.individual')}</dd>
          {p.district && (
            <>
              <dt>{t('place.district')}</dt>
              <dd>{f.district(p.district)}</dd>
            </>
          )}
          {p.badges.length > 0 && (
            <>
              <dt>{t('profile.verified')}</dt>
              <dd>
                <span className="badges">
                  {p.badges.map((b) => (
                    <span key={b} className="stamp">
                      {t(`badge.${b}`)}
                    </span>
                  ))}
                </span>
              </dd>
            </>
          )}
        </dl>
      </section>

      <dl className="tally" aria-label={t('profile.deals')}>
        <div className="tally__cell">
          <dt>{t('reviews.title')}</dt>
          <dd>
            {rep?.ratingAverage !== null && rep?.ratingAverage !== undefined
              ? num(Math.round(rep.ratingAverage * 10) / 10)
              : '—'}
          </dd>
        </div>
        <div className="tally__cell">
          <dt>{t('profile.completed')}</dt>
          <dd>{num(rep?.completedCount ?? 0)}</dd>
        </div>
        <div className="tally__cell">
          <dt>{t('profile.cancelled')}</dt>
          <dd>{num(rep?.cancelledCount ?? 0)}</dd>
        </div>
        <div className="tally__cell">
          <dt>{t('profile.disputed')}</dt>
          <dd>{num(rep?.disputedCount ?? 0)}</dd>
        </div>
      </dl>

      {p.seller && (
        <section aria-labelledby="sells-title">
          <div className="section-head">
            <h2 id="sells-title">{t('profile.sells')}</h2>
          </div>
          <dl className="facts">
            <dt>{t('profile.roles')}</dt>
            <dd>{p.seller.roles.map((r) => t(`role.${r}`)).join(', ') || '—'}</dd>
            <dt>{t('profile.categories')}</dt>
            <dd>
              {p.seller.categoryIds
                .map((c) => categories.name(c))
                .filter(Boolean)
                .join(', ') || '—'}
            </dd>
            <dt>{t('profile.areas')}</dt>
            <dd>
              {p.seller.serviceDistricts.map((d) => f.district(d)).join(', ') ||
                t('profile.anywhere')}
            </dd>
            <dt>{t('profile.delivery')}</dt>
            <dd>{p.seller.deliveryModes.map((d) => f.delivery(d)).join(', ') || '—'}</dd>
          </dl>
        </section>
      )}

      <Reviews userId={p.id} />
    </article>
  );
}

function Reviews({ userId }: { userId: string }) {
  const { t, num } = useI18n();
  const list = usePaged(['users', userId, 'reviews'], (cursor) =>
    trustApi.userReviews(userId, cursor),
  );
  const summary = list.data?.pages[0]?.summary;

  return (
    <section className="profile__reviews" aria-labelledby="reviews-title">
      <div className="section-head">
        <h2 id="reviews-title">{t('reviews.title')}</h2>
        {summary && (
          <p>
            {summary.ratingAverage !== null ? (
              <>
                <Rating value={summary.ratingAverage} />{' '}
                {t('profile.rating', {
                  avg: num(Math.round(summary.ratingAverage * 10) / 10),
                  n: summary.ratingCount,
                })}
              </>
            ) : (
              t('profile.noRating')
            )}
          </p>
        )}
      </div>
      {list.isPending && <LedgerSkeleton rows={3} />}
      {list.isError && <LoadError onRetry={() => void list.refetch()} />}
      {list.data && list.rows.length === 0 && <p className="muted">{t('reviews.empty')}</p>}
      {list.rows.length > 0 && (
        <ul className="reviews">
          {list.rows.map((r) => (
            <ReviewItem key={r.id} review={r} />
          ))}
        </ul>
      )}
      <MoreButton query={list} label={t('reviews.more')} />
    </section>
  );
}
