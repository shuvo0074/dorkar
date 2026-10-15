import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { TextField } from '../components/forms/fields';
import { AlertIcon, NoteIcon } from '../components/glyphs/glyphs';
import { LedgerSkeleton, LoadError } from '../components/ui/Status';
import { useSession } from '../features/auth/session';
import {
  catalogApi,
  listingCommands,
  listingEditable,
  type Listing,
  type ListingCommand,
} from '../features/catalog/api';
import { AttributeList } from '../features/catalog/AttributeList';
import { useCategories } from '../features/catalog/categories';
import { kindGlyph, listingCode, usePrice } from '../features/catalog/ListingEntry';
import { dealsApi } from '../features/deals/api';
import { MediaImage } from '../features/media/Photos';
import { MessageButton } from '../features/messages/MessageButton';
import { RentPanel } from '../features/rentals/RentPanel';
import { ReportButton } from '../features/trust/ReportButton';
import { UserLink } from '../features/trust/UserLink';
import { ApiError } from '../lib/http';
import { errorMessage, ruleOf } from '../lib/errors';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { asciiDigits } from '../lib/money';
import { useIntent } from '../lib/useIntent';
import NotFoundRoute from './NotFoundRoute';

export default function ListingRoute() {
  const { id = '' } = useParams();
  const listing = useQuery({ queryKey: ['listings', id], queryFn: () => catalogApi.listing(id) });
  if (listing.isPending) return <LedgerSkeleton rows={6} />;
  if (listing.error instanceof ApiError && listing.error.status === 404) return <NotFoundRoute />;
  if (listing.isError) return <LoadError onRetry={() => void listing.refetch()} />;
  return <ListingPage listing={listing.data} />;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="facts__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ListingPage({ listing }: { listing: Listing }) {
  const { t, num } = useI18n();
  const f = useFormat();
  const price = usePrice();
  const session = useSession();
  const categories = useCategories();
  const location = useLocation();
  const notice = (location.state as { notice?: 'created' | 'saved' } | null)?.notice;
  const mine = session.account?.id === listing.sellerId;
  const Glyph = kindGlyph[listing.kind];
  const [shown, setShown] = useState(0);

  return (
    <article className="item">
      <header className="item__head">
        <p className="crumb">
          <Link to="/listings">{t('nav.listings')}</Link>
        </p>
        <div className="item__tag">
          <span className="code">{t('listing.code', { code: listingCode(listing.id) })}</span>
          <span className="stamp">{t(`kind.${listing.kind}`)}</span>
          {listing.status !== 'PUBLISHED' && (
            <span className="stamp">{f.state(listing.status)}</span>
          )}
        </div>
        <h1 tabIndex={-1}>{listing.title}</h1>
        <p className="item__meta">
          {[price(listing), f.place({ district: listing.district, area: listing.area })].join(
            ' · ',
          )}
        </p>
        {notice && (
          <p className="alert alert--note" role="status">
            <NoteIcon />
            <span>
              {t(notice === 'created' ? 'listing.notice.created' : 'listing.notice.saved')}
            </span>
          </p>
        )}
        {mine && listing.status === 'HIDDEN' && (
          <p className="alert" role="status">
            <AlertIcon />
            <span>{t('listing.hidden')}</span>
          </p>
        )}
      </header>

      <section aria-labelledby="about-title">
        <div className="gallery">
          <div className="gallery__main">
            {listing.mediaIds.length > 0 ? (
              <MediaImage
                id={listing.mediaIds[shown]}
                variant="medium"
                alt={t('photos.photo', { n: num(shown + 1) })}
                fallback={<Glyph />}
              />
            ) : (
              <Glyph />
            )}
          </div>
          {listing.mediaIds.length > 1 && (
            <ul className="gallery__thumbs" aria-label={t('listing.photos')}>
              {listing.mediaIds.map((m, i) => (
                <li key={m}>
                  <button
                    type="button"
                    aria-pressed={i === shown}
                    aria-label={t('photos.photo', { n: num(i + 1) })}
                    onClick={() => setShown(i)}
                  >
                    <MediaImage id={m} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="section-head">
          <h2 id="about-title">{t('listing.about')}</h2>
        </div>
        {listing.description && <p className="item__desc">{listing.description}</p>}
        <dl className="facts">
          {!mine && (
            <Row label={t('listing.seller')}>
              <UserLink userId={listing.sellerId} />
            </Row>
          )}
          <Row label={t('listing.price')}>{price(listing)}</Row>
          <Row label={t('listing.available')}>
            {t('listing.availableN', { n: listing.quantityAvailable })}
          </Row>
          <Row label={t('listing.category')}>{categories.name(listing.categoryId) || '—'}</Row>
          {listing.condition && (
            <Row label={t('listing.condition')}>{f.condition(listing.condition)}</Row>
          )}
          <Row label={t('listing.place')}>
            {f.place({ district: listing.district, area: listing.area })}
          </Row>
          {listing.deliveryModes.length > 0 && (
            <Row label={t('listing.delivery')}>
              {listing.deliveryModes.map((d) => f.delivery(d)).join(', ')}
            </Row>
          )}
          <AttributeList categoryId={listing.categoryId} values={listing.attributes} />
        </dl>
      </section>

      <aside className="item__side" aria-label={t('listing.price')}>
        <div className="panel">
          <p className="item__count">{price(listing)}</p>
          {mine ? (
            <OwnerControls listing={listing} />
          ) : listing.status !== 'PUBLISHED' || listing.quantityAvailable === 0 ? (
            <p className="muted">{t('listing.unavailable')}</p>
          ) : session.status !== 'signedIn' ? (
            <Link
              className="btn btn--block"
              to="/sign-in"
              state={{ from: `/listings/${listing.id}` }}
            >
              {t(listing.kind === 'RENTAL' ? 'rent.signIn' : 'listing.signInToBuy')}
            </Link>
          ) : listing.kind === 'RENTAL' ? (
            <RentPanel listing={listing} />
          ) : (
            <BuyPanel listing={listing} />
          )}
          {!mine && session.status === 'signedIn' && (
            <MessageButton
              contextType="LISTING"
              contextId={listing.id}
              label={t('chat.messageSeller')}
            />
          )}
        </div>
        {!mine && <ReportButton targetType="LISTING" targetId={listing.id} />}
      </aside>
    </article>
  );
}

function BuyPanel({ listing }: { listing: Listing }) {
  const { t, has } = useI18n();
  const f = useFormat();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const intent = useIntent();
  const [qty, setQty] = useState('1');
  const [error, setError] = useState<string>();
  const wholeOnly = listing.priceUnit === 'TOTAL';
  const n = Number(asciiDigits(qty));
  const buy = useMutation({
    mutationFn: () => dealsApi.buy(listing.id, n, intent.key),
    onSuccess: (d) => {
      intent.renew();
      qc.setQueryData(['deals', d.id], d);
      void qc.invalidateQueries({ queryKey: ['me'] });
      void navigate(`/deals/${d.id}`);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!Number.isInteger(n) || n < 1 || n > listing.quantityAvailable)
      return setError(t('common.badNumber'));
    setError(undefined);
    buy.mutate();
  };
  const ruleKey = `listing.rule.${ruleOf(buy.error) ?? ''}`;

  return (
    <form className="buy" onSubmit={submit} noValidate>
      {!wholeOnly && listing.quantityAvailable > 1 && (
        <TextField
          label={t('listing.buyQty')}
          inputMode="numeric"
          value={qty}
          onChange={setQty}
          error={error}
        />
      )}
      {Number.isInteger(n) && n > 0 && (
        <p className="code">
          {t('listing.buyTotal', {
            amount: f.taka(wholeOnly ? listing.price.amount : listing.price.amount * n),
          })}
        </p>
      )}
      <button type="submit" className="btn btn--block" disabled={buy.isPending}>
        {t('listing.buy')}
      </button>
      <p className="field__hint">{t('listing.buyHelp')}</p>
      {buy.isError && (
        <p className="alert" role="alert">
          <AlertIcon />
          <span>{has(ruleKey) ? t(ruleKey) : errorMessage(buy.error, t)}</span>
        </p>
      )}
    </form>
  );
}

function OwnerControls({ listing }: { listing: Listing }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const run = useMutation({
    mutationFn: (c: ListingCommand) => catalogApi.listingCommand(listing.id, c),
    onSuccess: (saved) => {
      setConfirm(false);
      qc.setQueryData(['listings', listing.id], saved);
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const commands = listingCommands[listing.status];

  return (
    <div className="item__actions">
      <p className="label">{t('listing.yours')}</p>
      {listingEditable(listing.status) && (
        <Link className="btn btn--outline btn--small" to={`/listings/${listing.id}/edit`}>
          {t('common.edit')}
        </Link>
      )}
      {listing.kind === 'RENTAL' && (
        <Link className="btn btn--outline btn--small" to={`/listings/${listing.id}/rental`}>
          {t('rterms.title')}
        </Link>
      )}
      {commands
        .filter((c) => c !== 'withdraw')
        .map((c) => (
          <button
            key={c}
            type="button"
            className={c === 'publish' ? 'btn btn--small' : 'btn btn--outline btn--small'}
            disabled={run.isPending}
            onClick={() => run.mutate(c)}
          >
            {t(`listing.cmd.${c}`)}
          </button>
        ))}
      {commands.includes('withdraw') && !confirm && (
        <button
          type="button"
          className="btn btn--danger btn--small"
          onClick={() => setConfirm(true)}
        >
          {t('listing.cmd.withdraw')}
        </button>
      )}
      {confirm && (
        <div className="ledger__confirm" role="group" aria-label={t('listing.cmd.withdraw')}>
          <p>{t('listing.withdrawConfirm')}</p>
          <button
            type="button"
            className="btn btn--danger btn--small"
            disabled={run.isPending}
            onClick={() => run.mutate('withdraw')}
          >
            {t('listing.withdrawYes')}
          </button>
          <button
            type="button"
            className="btn btn--outline btn--small"
            onClick={() => setConfirm(false)}
          >
            {t('common.keep')}
          </button>
        </div>
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
