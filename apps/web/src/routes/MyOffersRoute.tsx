import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { Segmented } from '../components/forms/fields';
import { MoreButton, usePaged } from '../components/ui/Paging';
import { LedgerSkeleton, LoadError, SignedInOnly } from '../components/ui/Status';
import { needsApi } from '../features/needs/api';
import { needCode } from '../features/needs/modes';
import { modeGlyph } from '../features/needs/NeedEntry';
import { liveOffer, offersApi, type OfferStatus } from '../features/offers/api';
import { shortCode, useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';

export default function MyOffersRoute() {
  return (
    <SignedInOnly from="/my/offers">
      <div className="browse">
        <MyOffersHead />
        <Matched />
        <Sent />
      </div>
    </SignedInOnly>
  );
}

function MyOffersHead() {
  const { t } = useI18n();
  return (
    <header className="desk__head">
      <p className="crumb">
        <Link to="/dashboard">{t('nav.dashboard')}</Link>
      </p>
      <h1 tabIndex={-1}>{t('myOffers.title')}</h1>
      <p className="desk__lede">{t('myOffers.lede')}</p>
      <div className="desk__meta">
        <Link className="btn btn--outline btn--small" to="/needs">
          {t('myOffers.browse')}
        </Link>
      </div>
    </header>
  );
}

function Matched() {
  const { t } = useI18n();
  const f = useFormat();
  const qc = useQueryClient();
  const list = usePaged(['me', 'matched-needs'], (cursor) => needsApi.matchedNeeds(cursor));
  const dismiss = useMutation({
    mutationFn: needsApi.dismissMatch,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['me', 'matched-needs'] }),
  });

  return (
    <section aria-labelledby="matched-title">
      <div className="section-head">
        <h2 id="matched-title">{t('matched.title')}</h2>
        <p>{t('matched.note')}</p>
      </div>
      {list.isPending && <LedgerSkeleton rows={2} />}
      {list.isError && <LoadError onRetry={() => void list.refetch()} />}
      {list.data && list.rows.length === 0 && <p className="muted">{t('matched.empty')}</p>}
      {list.rows.length > 0 && (
        <ul className="ledger">
          {list.rows.map((m) => {
            const Glyph = modeGlyph[m.need.mode];
            return (
              <li key={m.matchId}>
                <span className="ledger__art">
                  <Glyph />
                </span>
                <div>
                  <Link className="ledger__title" to={`/needs/${m.need.id}`}>
                    {m.need.title}
                  </Link>
                  <p className="ledger__meta">
                    {[
                      needCode(m.need),
                      f.district(m.need.district),
                      f.range(m.need.budget.min, m.need.budget.max) ?? t('entry.open'),
                      t('matched.ends', { when: f.relative(m.need.expiresAt) }),
                    ].join(' · ')}
                  </p>
                </div>
                {m.status === 'RESPONDED' ? (
                  <span className="muted">{t('matched.responded')}</span>
                ) : (
                  <div className="ledger__btns">
                    <Link className="btn btn--small" to={`/needs/${m.need.id}/offer`}>
                      {t('matched.offer')}
                    </Link>
                    <button
                      type="button"
                      className="btn btn--outline btn--small"
                      disabled={dismiss.isPending}
                      onClick={() => dismiss.mutate(m.matchId)}
                    >
                      {t('matched.dismiss')}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <MoreButton query={list} />
    </section>
  );
}

const FILTERS = ['', 'SUBMITTED', 'COUNTERED_BY_BUYER', 'ACCEPTED', 'REJECTED', 'EXPIRED'] as const;

function Sent() {
  const { t, num } = useI18n();
  const f = useFormat();
  const [status, setStatus] = useState<(typeof FILTERS)[number]>('');
  const list = usePaged(['me', 'offers', status], (cursor) =>
    offersApi.mine((status || undefined) as OfferStatus | undefined, cursor),
  );

  return (
    <section aria-labelledby="sent-title">
      <div className="section-head">
        <h2 id="sent-title">{t('myOffers.sent')}</h2>
      </div>
      <Segmented
        legend={t('myNeeds.status')}
        hideLegend
        name="my-offers-status"
        value={status}
        onChange={setStatus}
        options={FILTERS.map((s) => ({ value: s, label: s ? f.state(s) : t('myNeeds.all') }))}
      />
      {list.isPending && <LedgerSkeleton rows={3} />}
      {list.isError && <LoadError onRetry={() => void list.refetch()} />}
      {list.data && list.rows.length === 0 && <p className="muted">{t('myOffers.empty')}</p>}
      {list.rows.length > 0 && (
        <ul className="ledger offers">
          {list.rows.map((o) => (
            <li key={o.id}>
              <span className="ledger__art">
                <span className="code">{shortCode('O', o.id)}</span>
              </span>
              <div>
                <Link className="ledger__title offers__amount" to={`/offers/${o.id}`}>
                  {f.taka(o.price)}
                  {o.quantity !== 1 && <span className="muted"> × {num(o.quantity)}</span>}
                </Link>
                <p className="ledger__meta">
                  {[f.state(o.status), f.relative(o.updatedAt)].join(' · ')}
                </p>
              </div>
              {liveOffer(o.status) && (
                <span className="muted">
                  {o.awaiting === 'SELLER' ? t('compare.yourTurn') : t('compare.theirTurn')}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <MoreButton query={list} />
    </section>
  );
}
