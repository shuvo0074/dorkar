import { DeliveryModes, findContactInfo, type DeliveryMode } from '@dorkar/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { SelectField, TextAreaField, TextField } from '../components/forms/fields';
import { AlertIcon, NoteIcon } from '../components/glyphs/glyphs';
import { LedgerSkeleton, LoadError, SignedInOnly } from '../components/ui/Status';
import { useSession } from '../features/auth/session';
import {
  dealCode,
  dealsApi,
  dealTitle,
  DisputeReasons,
  finalStates,
  type DealAction,
  type DealCommandBody,
  type DealDetail,
  type DisputeReason,
} from '../features/deals/api';
import { needsApi } from '../features/needs/api';
import { modeLetter } from '../features/needs/modes';
import { DealReviews } from '../features/trust/DealReviews';
import { ApiError } from '../lib/http';
import { errorMessage } from '../lib/errors';
import { useFormat } from '../lib/format';
import { useI18n, type MessageKey } from '../lib/i18n';
import { useIntent } from '../lib/useIntent';
import NotFoundRoute from './NotFoundRoute';

export default function DealRoute() {
  const { id = '' } = useParams();
  return (
    <SignedInOnly from={`/deals/${id}`}>
      <Loader id={id} />
    </SignedInOnly>
  );
}

function Loader({ id }: { id: string }) {
  const deal = useQuery({ queryKey: ['deals', id], queryFn: () => dealsApi.get(id) });
  if (deal.isPending) return <LedgerSkeleton rows={6} />;
  if (deal.error instanceof ApiError && deal.error.status === 404) return <NotFoundRoute />;
  if (deal.isError) return <LoadError onRetry={() => void deal.refetch()} />;
  return <DealPage deal={deal.data} />;
}

const sourceLink = (d: DealDetail): string | null => {
  switch (d.sourceType) {
    case 'OFFER':
      return `/offers/${d.sourceId}`;
    case 'LISTING':
      return d.listingId ? `/listings/${d.listingId}` : null;
    case 'AUCTION':
      return `/auctions/${d.sourceId}`;
    case 'BOOKING':
      return `/bookings/${d.sourceId}`;
    case 'LOAN':
      return `/loans/${d.sourceId}`;
  }
};

function DealPage({ deal }: { deal: DealDetail }) {
  const { t, num, date, has } = useI18n();
  const f = useFormat();
  const me = useSession().account?.id;
  const need = useQuery({
    queryKey: ['needs', deal.needId],
    queryFn: () => needsApi.get(deal.needId!),
    enabled: Boolean(deal.needId),
  });
  const title = dealTitle(deal) ?? need.data?.title ?? t('deals.code', { code: dealCode(deal.id) });
  const role = deal.viewerRole;
  const mineConfirmed = role === 'BUYER' ? deal.buyerConfirmedAt : deal.sellerConfirmedAt;
  const theirsConfirmed = role === 'BUYER' ? deal.sellerConfirmedAt : deal.buyerConfirmedAt;
  const source = sourceLink(deal);

  return (
    <article className="item">
      <header className="item__head">
        <p className="crumb">
          <Link to="/deals">{t('nav.deals')}</Link>
        </p>
        <div className="item__tag">
          <span className="modetile" aria-hidden="true">
            {modeLetter[deal.mode]}
          </span>
          <span className="code">{t('deals.code', { code: dealCode(deal.id) })}</span>
          <span className={finalStates.has(deal.state) ? 'stamp' : 'stamp stamp--ink'}>
            {f.state(deal.state)}
          </span>
          {role && <span className="muted">{t(`deals.as.${role}`)}</span>}
        </div>
        <h1 tabIndex={-1}>{title}</h1>
        <p className="item__meta">
          {f.taka(deal.amount)}
          {deal.quantity > 1 && ` × ${num(deal.quantity)}`} · {t('deal.payment.cash')}
        </p>
      </header>

      <section aria-labelledby="deal-facts">
        <div className="section-head">
          <h2 id="deal-facts">{t('need.details')}</h2>
        </div>
        <dl className="facts">
          <Row label={t('deal.amount')}>{f.taka(deal.amount)}</Row>
          <Row label={t('deal.quantity')}>{num(deal.quantity)}</Row>
          <Row label={t('deal.mode')}>{t(`mode.${deal.mode}`)}</Row>
          <Row label={t('deal.source')}>
            {t(`deal.source.${deal.sourceType}`)}
            {source && (
              <span className="facts__aside">
                <Link to={source}>{t('deal.openSource')}</Link>
              </span>
            )}
          </Row>
          {deal.needId && (
            <Row label={t('deal.need')}>
              <Link to={`/needs/${deal.needId}`}>{need.data?.title ?? t('deal.openSource')}</Link>
            </Row>
          )}
          {deal.state === 'CREATED' && (
            <Row label={t('deal.confirmations')}>
              {mineConfirmed && theirsConfirmed
                ? t('deal.confirmed.both')
                : mineConfirmed
                  ? t('deal.confirmed.you')
                  : theirsConfirmed
                    ? t('deal.confirmed.them')
                    : t('deal.confirmed.none')}
            </Row>
          )}
          {deal.payment && (
            <Row label={t('deal.payment')}>
              {f.taka(deal.payment.amount)} · {t(`deal.payment.${deal.payment.status}`)}
            </Row>
          )}
          {deal.delivery && (
            <Row label={t('deal.delivery')}>
              {f.delivery(deal.delivery.method)} · {t(`deal.delivery.${deal.delivery.status}`)}
              {deal.delivery.scheduledFor && (
                <span className="facts__aside">
                  {t('deal.scheduled', { when: date(deal.delivery.scheduledFor) })}
                </span>
              )}
              {deal.delivery.notes && <span className="facts__aside">“{deal.delivery.notes}”</span>}
            </Row>
          )}
          {deal.deposit && (
            <Row label={t('deal.deposit')}>
              {f.taka(deal.deposit.amount)} · {t(`deal.deposit.${deal.deposit.status}`)}
            </Row>
          )}
          {deal.cancelReason && <Row label={t('deal.cancelReason')}>{deal.cancelReason}</Row>}
          {deal.disputeReason && (
            <Row label={t('deal.disputeReason')}>
              {deal.disputeCategory && `${t(`reason.${deal.disputeCategory}`)}: `}
              {deal.disputeReason}
            </Row>
          )}
        </dl>
      </section>

      <aside className="item__side" aria-label={t('need.details')}>
        <div className="panel">
          <Actions deal={deal} />
        </div>
      </aside>

      {deal.state === 'COMPLETED' && role && <DealReviews transactionId={deal.id} />}

      <section className="item__wide" aria-labelledby="deal-timeline">
        <div className="section-head">
          <h2 id="deal-timeline">{t('deal.timeline')}</h2>
        </div>
        <ol className="timeline">
          {[...deal.transitions].reverse().map((tr, i) => (
            <li key={i}>
              <time className="code" dateTime={tr.at}>
                {date(tr.at)}
              </time>
              <span>
                {tr.from === tr.to ? f.state(tr.to) : `${f.state(tr.from)} → ${f.state(tr.to)}`}
              </span>
              <span className="muted">
                {tr.actorId && tr.actorId === me
                  ? t('deal.byYou')
                  : has(`deal.by.${tr.actorRole}`)
                    ? t(`deal.by.${tr.actorRole}` as MessageKey)
                    : tr.actorRole.toLowerCase()}
                {tr.reason && ` · “${tr.reason}”`}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="facts__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Steps whose button is the primary (ink) one; everything else is outlined. */
const FORWARD: DealAction[] = [
  'confirm',
  'mark-delivered',
  'confirm-receipt',
  'hand-over',
  'report-return',
  'confirm-return',
  'complete',
];

function Actions({ deal }: { deal: DealDetail }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const intent = useIntent();
  const [open, setOpen] = useState<'cancel' | 'arrange-delivery' | 'dispute' | null>(null);
  const run = useMutation({
    mutationFn: (cmd: DealCommandBody) => dealsApi.command(deal.id, cmd, intent.key),
    onSuccess: (next) => {
      intent.renew();
      setOpen(null);
      qc.setQueryData(['deals', deal.id], next);
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });

  if (finalStates.has(deal.state)) return <p className="item__count">{t('deal.final')}</p>;
  if (deal.actions.length === 0) return <p className="muted">{t('deal.noActions')}</p>;

  const forward = deal.actions.filter((a) => FORWARD.includes(a));
  return (
    <div className="item__actions">
      {open === null && (
        <>
          {forward.map((a, i) => (
            <div key={a} className="dealstep">
              <button
                type="button"
                className={i === 0 ? 'btn btn--block' : 'btn btn--outline btn--block'}
                disabled={run.isPending}
                onClick={() => run.mutate({ action: a } as DealCommandBody)}
              >
                {t(`deal.cmd.${a}`)}
              </button>
              {(a === 'confirm' ||
                a === 'mark-delivered' ||
                a === 'confirm-receipt' ||
                a === 'complete') && <p className="field__hint">{t(`deal.help.${a}`)}</p>}
            </div>
          ))}
          {deal.actions.includes('arrange-delivery') && (
            <button
              type="button"
              className="btn btn--outline btn--small"
              onClick={() => setOpen('arrange-delivery')}
            >
              {t('deal.cmd.arrange-delivery')}
            </button>
          )}
          {deal.actions.includes('dispute') && (
            <button
              type="button"
              className="btn btn--outline btn--small"
              onClick={() => setOpen('dispute')}
            >
              {t('deal.cmd.dispute')}
            </button>
          )}
          {deal.actions.includes('cancel') && (
            <button
              type="button"
              className="btn btn--danger btn--small"
              onClick={() => setOpen('cancel')}
            >
              {t('deal.cmd.cancel')}
            </button>
          )}
        </>
      )}
      {open === 'cancel' && (
        <CancelForm busy={run.isPending} onSend={run.mutate} onClose={() => setOpen(null)} />
      )}
      {open === 'arrange-delivery' && (
        <ArrangeForm busy={run.isPending} onSend={run.mutate} onClose={() => setOpen(null)} />
      )}
      {open === 'dispute' && (
        <DisputeForm
          mode={deal.mode}
          busy={run.isPending}
          onSend={run.mutate}
          onClose={() => setOpen(null)}
        />
      )}
      {run.isError && (
        <p className="alert" role="alert">
          <AlertIcon />
          <span>{errorMessage(run.error, t)}</span>
        </p>
      )}
    </div>
  );
}

interface SubForm {
  busy: boolean;
  onSend: (cmd: DealCommandBody) => void;
  onClose: () => void;
}

function CancelForm({ busy, onSend, onClose }: SubForm) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < 3) return setError(t('common.required'));
    onSend({ action: 'cancel', reason: reason.trim() });
  };
  return (
    <form className="counter counter--danger" onSubmit={submit} noValidate>
      <TextAreaField
        label={t('deal.cancel.reason')}
        value={reason}
        onChange={setReason}
        maxLength={500}
        rows={3}
        error={error}
      />
      <div className="formactions">
        <button type="submit" className="btn btn--danger btn--small" disabled={busy}>
          {t('deal.cancel.yes')}
        </button>
        <button type="button" className="btn btn--outline btn--small" onClick={onClose}>
          {t('common.keep')}
        </button>
      </div>
    </form>
  );
}

function ArrangeForm({ busy, onSend, onClose }: SubForm) {
  const { t } = useI18n();
  const f = useFormat();
  const [method, setMethod] = useState<DeliveryMode>('SELF_ARRANGED');
  const [when, setWhen] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (findContactInfo(notes)) return setError(t('needForm.contact'));
    onSend({
      action: 'arrange-delivery',
      method,
      ...(when ? { scheduledFor: new Date(when).toISOString() } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    });
  };
  return (
    <form className="counter" onSubmit={submit} noValidate>
      <SelectField
        label={t('deal.arrange.method')}
        value={method}
        onChange={(v) => setMethod(v as DeliveryMode)}
        options={DeliveryModes.map((d) => ({ value: d, label: f.delivery(d) }))}
      />
      <TextField
        type="datetime-local"
        label={t('deal.arrange.when')}
        optional
        value={when}
        onChange={setWhen}
      />
      <TextAreaField
        label={t('deal.arrange.notes')}
        optional
        hint={t('deal.arrange.notesHint')}
        value={notes}
        onChange={setNotes}
        maxLength={500}
        rows={3}
        error={error}
      />
      <div className="formactions">
        <button type="submit" className="btn btn--small" disabled={busy}>
          {t('deal.arrange.send')}
        </button>
        <button type="button" className="btn btn--outline btn--small" onClick={onClose}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}

function DisputeForm({ busy, onSend, onClose, mode }: SubForm & { mode: DealDetail['mode'] }) {
  const { t } = useI18n();
  const [category, setCategory] = useState<DisputeReason>(
    mode === 'RENT' || mode === 'BORROW' ? 'NOT_RETURNED' : 'NOT_RECEIVED',
  );
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < 3) return setError(t('common.required'));
    onSend({ action: 'dispute', reason: reason.trim(), category });
  };
  return (
    <form className="counter" onSubmit={submit} noValidate>
      <p className="alert alert--note">
        <NoteIcon />
        <span>{t('deal.dispute.help')}</span>
      </p>
      <SelectField
        label={t('deal.dispute.category')}
        value={category}
        onChange={(v) => setCategory(v as DisputeReason)}
        options={DisputeReasons.map((r) => ({ value: r, label: t(`reason.${r}`) }))}
      />
      <TextAreaField
        label={t('deal.dispute.reason')}
        value={reason}
        onChange={setReason}
        maxLength={500}
        rows={4}
        error={error}
      />
      <div className="formactions">
        <button type="submit" className="btn btn--small" disabled={busy}>
          {t('deal.dispute.send')}
        </button>
        <button type="button" className="btn btn--outline btn--small" onClick={onClose}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}
