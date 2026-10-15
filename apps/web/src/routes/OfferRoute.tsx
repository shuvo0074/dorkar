import { findContactInfo } from '@dorkar/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { MoneyField, TextAreaField, TextField } from '../components/forms/fields';
import { AlertIcon, NoteIcon } from '../components/glyphs/glyphs';
import { Biro } from '../components/ui/Biro';
import { LedgerSkeleton, LoadError } from '../components/ui/Status';
import { SignedInOnly } from '../components/ui/Status';
import { useSession } from '../features/auth/session';
import { needsApi } from '../features/needs/api';
import { modeLetter } from '../features/needs/modes';
import { offersApi, type OfferAction, type OfferDetail } from '../features/offers/api';
import { OfferTermsList } from '../features/offers/OfferTerms';
import { UserLink } from '../features/trust/UserLink';
import { ApiError } from '../lib/http';
import { errorMessage } from '../lib/errors';
import { shortCode, useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { asciiDigits, parseTaka, poisha, takaInput } from '../lib/money';
import { useIntent } from '../lib/useIntent';
import NotFoundRoute from './NotFoundRoute';

export default function OfferRoute() {
  const { id = '' } = useParams();
  return (
    <SignedInOnly from={`/offers/${id}`}>
      <Loader id={id} />
    </SignedInOnly>
  );
}

function Loader({ id }: { id: string }) {
  const offer = useQuery({ queryKey: ['offers', id], queryFn: () => offersApi.get(id) });
  if (offer.isPending) return <LedgerSkeleton rows={6} />;
  if (offer.error instanceof ApiError && offer.error.status === 404) return <NotFoundRoute />;
  if (offer.isError) return <LoadError onRetry={() => void offer.refetch()} />;
  return <OfferPage offer={offer.data} />;
}

export const offerCode = (id: string) => shortCode('O', id);

function OfferPage({ offer }: { offer: OfferDetail }) {
  const { t, num, date } = useI18n();
  const f = useFormat();
  const session = useSession();
  const location = useLocation();
  const [accepted, setAccepted] = useState(false);
  const notice = (location.state as { notice?: 'sent' } | null)?.notice;
  const need = useQuery({
    queryKey: ['needs', offer.needId],
    queryFn: () => needsApi.get(offer.needId),
  });
  const role = session.account?.id === offer.buyerId ? 'BUYER' : 'SELLER';
  const d = offer.deliveryTerms;

  return (
    <article className="item">
      <header className="item__head">
        <p className="crumb">
          {need.data ? (
            <Link to={`/needs/${offer.needId}`}>{need.data.title}</Link>
          ) : (
            <Link to={`/needs/${offer.needId}`}>{t('offer.onNeed')}</Link>
          )}
        </p>
        <div className="item__tag">
          {need.data && (
            <span className="modetile" aria-hidden="true">
              {modeLetter[need.data.mode]}
            </span>
          )}
          <span className="code">{t('offer.title', { code: offerCode(offer.id) })}</span>
          <span className="stamp">{f.state(offer.status)}</span>
          <span className="muted">
            {t(role === 'BUYER' ? 'offer.theirOffer' : 'offer.yourOffer')}
          </span>
        </div>
        <h1 tabIndex={-1}>
          {f.taka(offer.price)}
          <span className="item__sub"> × {num(offer.quantity)}</span>
        </h1>
        {notice === 'sent' && (
          <p className="alert alert--note" role="status">
            <NoteIcon />
            <span>{t('offer.sent')}</span>
          </p>
        )}
        {(accepted || offer.status === 'ACCEPTED') && (
          <p className="alert alert--note" role="status">
            <NoteIcon />
            <span>
              {t('offer.accepted')} <Link to="/deals">{t('nav.deals')}</Link>
            </span>
          </p>
        )}
        {offer.hidden && (
          <p className="alert" role="status">
            <AlertIcon />
            <span>{t('offer.hidden')}</span>
          </p>
        )}
      </header>

      <section aria-labelledby="terms-title">
        <div className="section-head">
          <h2 id="terms-title">{t('need.details')}</h2>
        </div>
        {offer.description && <p className="item__desc">{offer.description}</p>}
        <dl className="facts">
          <div className="facts__row">
            <dt>{t('deal.otherSide')}</dt>
            <dd>
              <UserLink userId={role === 'BUYER' ? offer.sellerId : offer.buyerId} />
            </dd>
          </div>
          <div className="facts__row">
            <dt>{t('offer.quantity')}</dt>
            <dd>{num(offer.quantity)}</dd>
          </div>
          {offer.condition && (
            <div className="facts__row">
              <dt>{t('offer.condition')}</dt>
              <dd>{f.condition(offer.condition)}</dd>
            </div>
          )}
          <div className="facts__row">
            <dt>{t('offer.delivery')}</dt>
            <dd>
              {d.feeAmount
                ? t('offer.deliveryFee', { method: f.delivery(d.method), fee: f.taka(d.feeAmount) })
                : f.delivery(d.method)}
              {d.etaDays !== undefined && (
                <span className="facts__aside">{t('offer.eta', { n: d.etaDays })}</span>
              )}
            </dd>
          </div>
          {offer.availabilityFrom && (
            <div className="facts__row">
              <dt>{t('offer.available')}</dt>
              <dd>{date(offer.availabilityFrom, 'short')}</dd>
            </div>
          )}
          <OfferTermsList terms={offer.modeTerms} />
        </dl>
      </section>

      <aside className="item__side" aria-label={t('offer.rounds')}>
        <div className="panel">
          {offer.awaiting && (
            <p className="item__count">
              {offer.awaiting === role ? (
                <span className="tally__mark">
                  {t('compare.yourTurn')}
                  <Biro draw tilt={-3} />
                </span>
              ) : (
                t('compare.theirTurn')
              )}
            </p>
          )}
          {offer.status !== 'ACCEPTED' && offer.awaiting && (
            <p className="muted">{t('offer.expires', { when: date(offer.expiresAt) })}</p>
          )}
          <Actions offer={offer} onAccepted={() => setAccepted(true)} />
        </div>
      </aside>

      <section className="item__wide" aria-labelledby="rounds-title">
        <div className="section-head">
          <h2 id="rounds-title">{t('offer.rounds')}</h2>
        </div>
        <ol className="timeline">
          {[...offer.rounds].reverse().map((r) => (
            <li key={r.round}>
              <time className="code" dateTime={r.createdAt}>
                {date(r.createdAt)}
              </time>
              <span>
                <strong>{t('offer.round', { n: r.round })}</strong> ·{' '}
                {r.proposedBy === role ? t('offer.you') : t(`offer.by.${r.proposedBy}`)} ·{' '}
                {f.taka(r.price)} × {num(r.quantity)}
              </span>
              {r.message && <span className="muted">“{r.message}”</span>}
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}

function Actions({ offer, onAccepted }: { offer: OfferDetail; onAccepted: () => void }) {
  const { t, num } = useI18n();
  const f = useFormat();
  const qc = useQueryClient();
  const intent = useIntent();
  const [open, setOpen] = useState<OfferAction | null>(null);

  const done = (next: OfferDetail) => {
    intent.renew();
    setOpen(null);
    qc.setQueryData(['offers', offer.id], next);
    void qc.invalidateQueries({ queryKey: ['me'] });
    void qc.invalidateQueries({ queryKey: ['offers', 'need', offer.needId] });
    void qc.invalidateQueries({ queryKey: ['needs', offer.needId] });
  };
  const act = useMutation({
    mutationFn: (a: Exclude<OfferAction, 'COUNTER'>) =>
      a === 'ACCEPT'
        ? offersApi.accept(offer.id, intent.key)
        : a === 'REJECT'
          ? offersApi.reject(offer.id)
          : offersApi.withdraw(offer.id),
    onSuccess: (next, a) => {
      done(next);
      if (a === 'ACCEPT') onAccepted();
    },
  });

  if (offer.actions.length === 0) return null;

  const confirmBox = (a: 'ACCEPT' | 'REJECT' | 'WITHDRAW') => {
    const text =
      a === 'ACCEPT'
        ? t('offer.acceptConfirm', { price: f.taka(offer.price), n: num(offer.quantity) })
        : t(a === 'REJECT' ? 'offer.rejectConfirm' : 'offer.withdrawConfirm');
    const yes = t(
      a === 'ACCEPT' ? 'offer.acceptYes' : a === 'REJECT' ? 'offer.rejectYes' : 'offer.withdrawYes',
    );
    return (
      <div
        className={a === 'ACCEPT' ? 'ledger__confirm ledger__confirm--ink' : 'ledger__confirm'}
        role="group"
        aria-label={yes}
      >
        <p>{text}</p>
        <button
          type="button"
          className={a === 'ACCEPT' ? 'btn btn--small' : 'btn btn--danger btn--small'}
          disabled={act.isPending}
          onClick={() => act.mutate(a)}
        >
          {yes}
        </button>
        <button type="button" className="btn btn--outline btn--small" onClick={() => setOpen(null)}>
          {t('common.keep')}
        </button>
      </div>
    );
  };

  return (
    <div className="item__actions">
      {open === null && (
        <>
          {offer.actions.includes('ACCEPT') && (
            <button type="button" className="btn btn--small" onClick={() => setOpen('ACCEPT')}>
              {t('offer.accept')}
            </button>
          )}
          {offer.actions.includes('COUNTER') && (
            <button
              type="button"
              className="btn btn--outline btn--small"
              onClick={() => setOpen('COUNTER')}
            >
              {t('offer.counter')}
            </button>
          )}
          {offer.actions.includes('REJECT') && (
            <button
              type="button"
              className="btn btn--danger btn--small"
              onClick={() => setOpen('REJECT')}
            >
              {t('offer.reject')}
            </button>
          )}
          {offer.actions.includes('WITHDRAW') && (
            <button
              type="button"
              className="btn btn--danger btn--small"
              onClick={() => setOpen('WITHDRAW')}
            >
              {t('offer.withdraw')}
            </button>
          )}
        </>
      )}
      {(open === 'ACCEPT' || open === 'REJECT' || open === 'WITHDRAW') && confirmBox(open)}
      {open === 'COUNTER' && (
        <Counter
          offer={offer}
          intentKey={intent.key}
          onDone={done}
          onCancel={() => setOpen(null)}
        />
      )}
      {act.isError && (
        <p className="alert" role="alert">
          <AlertIcon />
          <span>{errorMessage(act.error, t)}</span>
        </p>
      )}
    </div>
  );
}

function Counter({
  offer,
  intentKey,
  onDone,
  onCancel,
}: {
  offer: OfferDetail;
  intentKey: string;
  onDone: (o: OfferDetail) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [price, setPrice] = useState(takaInput(offer.price));
  const [quantity, setQuantity] = useState(String(offer.quantity));
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const send = useMutation({
    mutationFn: (input: Parameters<typeof offersApi.counter>[1]) =>
      offersApi.counter(offer.id, input, intentKey),
    onSuccess: onDone,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = parseTaka(price);
    const q = Number(asciiDigits(quantity));
    const errs = {
      price: p === null || p === 0 ? t('common.badAmount') : undefined,
      quantity: !Number.isInteger(q) || q < 1 ? t('common.badNumber') : undefined,
      message: findContactInfo(message) ? t('needForm.contact') : undefined,
    };
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) return;
    send.mutate({
      price: poisha(p!),
      quantity: q,
      ...(message.trim() ? { message: message.trim() } : {}),
    });
  };

  return (
    <form className="counter" onSubmit={submit} noValidate aria-labelledby="counter-title">
      <h3 id="counter-title">{t('offer.counterTitle')}</h3>
      <div className="pair">
        <MoneyField
          label={t('offer.price')}
          value={price}
          onChange={setPrice}
          error={errors['price']}
        />
        <TextField
          label={t('offer.quantity')}
          inputMode="numeric"
          value={quantity}
          onChange={setQuantity}
          error={errors['quantity']}
        />
      </div>
      <TextAreaField
        label={t('offer.counterMessage')}
        optional
        value={message}
        onChange={setMessage}
        maxLength={1000}
        rows={3}
        error={errors['message']}
      />
      {send.isError && (
        <p className="alert" role="alert">
          <AlertIcon />
          <span>{errorMessage(send.error, t)}</span>
        </p>
      )}
      <div className="formactions">
        <button type="submit" className="btn btn--small" disabled={send.isPending}>
          {t('offer.counterSend')}
        </button>
        <button type="button" className="btn btn--outline btn--small" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}
