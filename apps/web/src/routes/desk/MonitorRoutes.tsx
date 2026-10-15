import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Segmented, TextAreaField } from '../../components/forms/fields';
import { AlertIcon, GavelGlyph } from '../../components/glyphs/glyphs';
import { MoreButton, usePaged } from '../../components/ui/Paging';
import { LedgerSkeleton, LoadError } from '../../components/ui/Status';
import {
  auctionCode,
  auctionsApi,
  AuctionStatuses,
  type Auction,
  type AuctionStatus,
} from '../../features/auctions/api';
import { dealCode, dealTitle } from '../../features/deals/api';
import { deskApi } from '../../features/desk/api';
import { DeskCrumb, StaffPage } from '../../features/desk/tools';
import { loanCode } from '../../features/lending/api';
import { bookingCode } from '../../features/rentals/api';
import { errorMessage } from '../../lib/errors';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { useIntent } from '../../lib/useIntent';

export function AuctionMonitorRoute() {
  return (
    <StaffPage needs="auction:manage" from="/desk/auctions">
      <Auctions />
    </StaffPage>
  );
}

function Auctions() {
  const { t } = useI18n();
  const f = useFormat();
  const [status, setStatus] = useState<AuctionStatus | ''>('OPEN');
  const list = usePaged(['desk', 'auctions', status], (cursor) =>
    auctionsApi.adminList(status || undefined, cursor),
  );
  return (
    <div className="browse">
      <header className="desk__head">
        <DeskCrumb />
        <h1 tabIndex={-1}>{t('smon.auctions')}</h1>
        <p className="desk__lede">{t('smon.auctionsLede')}</p>
      </header>
      <section aria-labelledby="mon-auctions">
        <div className="section-head">
          <h2 id="mon-auctions">{t('smon.auctions')}</h2>
        </div>
        <Segmented
          legend={t('auctions.status')}
          hideLegend
          name="mon-auction-status"
          value={status}
          onChange={setStatus}
          options={[
            { value: '' as const, label: t('staff.any') },
            ...AuctionStatuses.map((s) => ({ value: s, label: f.state(s) })),
          ]}
        />
        {list.isPending && <LedgerSkeleton rows={4} />}
        {list.isError && <LoadError onRetry={() => void list.refetch()} />}
        {list.data && list.rows.length === 0 && <p className="muted">{t('auctions.empty')}</p>}
        {list.rows.length > 0 && (
          <ul className="ledger">
            {list.rows.map((a) => (
              <AuctionRow key={a.id} a={a} />
            ))}
          </ul>
        )}
        <MoreButton query={list} />
      </section>
    </div>
  );
}

function AuctionRow({ a }: { a: Auction }) {
  const { t } = useI18n();
  const f = useFormat();
  const qc = useQueryClient();
  const intent = useIntent();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const cancel = useMutation({
    mutationFn: () => auctionsApi.adminCancel(a.id, reason.trim(), intent.key),
    onSuccess: () => {
      intent.renew();
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['desk', 'auctions'] });
    },
  });
  const live = a.status === 'OPEN' || a.status === 'SCHEDULED' || a.status === 'CLOSING';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < 3) return setError(t('staff.reasonHint'));
    setError(undefined);
    cancel.mutate();
  };
  return (
    <li>
      <span className="ledger__art">
        <GavelGlyph />
      </span>
      <div>
        <Link className="ledger__title" to={`/auctions/${a.id}`}>
          {a.title}
        </Link>
        <p className="ledger__meta">
          {[
            auctionCode(a.id),
            t(`auctions.kind.${a.kind}`),
            f.state(a.status),
            a.hidden && t('mod.hidden'),
            t('auction.bids', { n: a.bidCount }),
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {open && (
          <form className="counter counter--danger" onSubmit={submit} noValidate>
            <TextAreaField
              label={t('staff.reason')}
              hint={t('staff.reasonHint')}
              value={reason}
              onChange={setReason}
              maxLength={500}
              rows={2}
              error={error}
            />
            <div className="formactions">
              <button
                type="submit"
                className="btn btn--danger btn--small"
                disabled={cancel.isPending}
              >
                {t('smon.cancel')}
              </button>
              <button
                type="button"
                className="btn btn--outline btn--small"
                onClick={() => setOpen(false)}
              >
                {t('common.keep')}
              </button>
            </div>
            {cancel.isError && (
              <p className="alert" role="alert">
                <AlertIcon />
                <span>{errorMessage(cancel.error, t)}</span>
              </p>
            )}
          </form>
        )}
      </div>
      {live && !open && (
        <button type="button" className="btn btn--danger btn--small" onClick={() => setOpen(true)}>
          {t('smon.cancel')}
        </button>
      )}
    </li>
  );
}

export function DealMonitorRoute() {
  return (
    <StaffPage needs="transaction:read:any" from="/desk/deals">
      <Deals />
    </StaffPage>
  );
}

function Deals() {
  const { t, date } = useI18n();
  const f = useFormat();
  const [tab, setTab] = useState<'deals' | 'bookings' | 'loans'>('deals');
  const deals = usePaged(['desk', 'deals'], (c) => deskApi.deals(undefined, c), {
    enabled: tab === 'deals',
  });
  const bookings = usePaged(['desk', 'bookings'], (c) => deskApi.bookings(undefined, c), {
    enabled: tab === 'bookings',
  });
  const loans = usePaged(['desk', 'loans'], (c) => deskApi.loans(undefined, c), {
    enabled: tab === 'loans',
  });
  const current = tab === 'deals' ? deals : tab === 'bookings' ? bookings : loans;

  return (
    <div className="browse">
      <header className="desk__head">
        <DeskCrumb />
        <h1 tabIndex={-1}>{t('smon.deals')}</h1>
        <p className="desk__lede">{t('smon.dealsLede')}</p>
      </header>
      <section aria-labelledby="mon-deals">
        <div className="section-head">
          <h2 id="mon-deals">{t(`smon.tab.${tab}`)}</h2>
        </div>
        <Segmented
          legend={t('smon.deals')}
          hideLegend
          name="mon-tab"
          value={tab}
          onChange={setTab}
          options={(['deals', 'bookings', 'loans'] as const).map((x) => ({
            value: x,
            label: t(`smon.tab.${x}`),
          }))}
        />
        {current.isPending && <LedgerSkeleton rows={5} />}
        {current.isError && <LoadError onRetry={() => void current.refetch()} />}
        {current.data && current.rows.length === 0 && <p className="muted">{t('common.none')}</p>}
        <ul className="ledger">
          {tab === 'deals' &&
            deals.rows.map((d) => (
              <li key={d.id}>
                <span className="ledger__art code">{t(`mode.${d.mode}`)}</span>
                <div>
                  <Link className="ledger__title" to={`/deals/${d.id}`}>
                    {dealTitle(d) ?? dealCode(d.id)}
                  </Link>
                  <p className="ledger__meta">
                    {[dealCode(d.id), f.taka(d.amount), f.state(d.state), date(d.createdAt)].join(
                      ' · ',
                    )}
                  </p>
                </div>
              </li>
            ))}
          {tab === 'bookings' &&
            bookings.rows.map((b) => (
              <li key={b.id}>
                <span className="ledger__art code">{bookingCode(b.id)}</span>
                <div>
                  <Link className="ledger__title" to={`/bookings/${b.id}`}>
                    {typeof b.terms['listingTitle'] === 'string'
                      ? b.terms['listingTitle']
                      : bookingCode(b.id)}
                  </Link>
                  <p className="ledger__meta">
                    {[
                      f.taka(b.amount),
                      f.state(b.status),
                      t('dash.period', {
                        from: date(b.startAt, 'short'),
                        to: date(b.endAt, 'short'),
                      }),
                    ].join(' · ')}
                  </p>
                </div>
              </li>
            ))}
          {tab === 'loans' &&
            loans.rows.map((l) => (
              <li key={l.id}>
                <span className="ledger__art code">{loanCode(l.id)}</span>
                <div>
                  <Link className="ledger__title" to={`/loans/${l.id}`}>
                    {l.itemTitle}
                  </Link>
                  <p className="ledger__meta">
                    {[
                      f.state(l.status),
                      l.overdue && t('loan.overdue'),
                      t('dash.returnBy', { when: date(l.returnBy, 'short') }),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
              </li>
            ))}
        </ul>
        <MoreButton query={current} />
      </section>
    </div>
  );
}
