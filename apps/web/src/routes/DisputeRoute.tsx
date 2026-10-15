import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { TextAreaField } from '../components/forms/fields';
import { AlertIcon, ScalesGlyph } from '../components/glyphs/glyphs';
import { LedgerSkeleton, LoadError, SignedInOnly } from '../components/ui/Status';
import { useSession } from '../features/auth/session';
import { dealCode } from '../features/deals/api';
import { disputesApi, type DisputeDetail, type Entry } from '../features/disputes/api';
import { StaffPanel } from '../features/disputes/StaffPanel';
import { MediaImage, PhotoPicker } from '../features/media/Photos';
import { ApiError } from '../lib/http';
import { errorMessage } from '../lib/errors';
import { shortCode, useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useIntent } from '../lib/useIntent';
import NotFoundRoute from './NotFoundRoute';

export default function DisputeRoute() {
  const { id = '' } = useParams();
  return (
    <SignedInOnly from={`/disputes/${id}`}>
      <Loader id={id} />
    </SignedInOnly>
  );
}

function Loader({ id }: { id: string }) {
  const d = useQuery({ queryKey: ['disputes', id], queryFn: () => disputesApi.get(id) });
  if (d.isPending) return <LedgerSkeleton rows={6} />;
  if (d.error instanceof ApiError && d.error.status === 404) return <NotFoundRoute />;
  if (d.isError) return <LoadError onRetry={() => void d.refetch()} />;
  return <DisputePage d={d.data} />;
}

export const disputeCode = (id: string) => shortCode('D', id);

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="facts__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function DisputePage({ d }: { d: DisputeDetail }) {
  const { t, date } = useI18n();
  const f = useFormat();
  const staff = d.viewerRole === 'STAFF';
  const live = d.status !== 'RESOLVED' && d.status !== 'WITHDRAWN';

  return (
    <article className="item">
      <header className="item__head">
        <p className="crumb">
          {staff ? (
            <Link to="/desk/disputes">{t('nav.desk')}</Link>
          ) : (
            <Link to="/disputes">{t('disputes.title')}</Link>
          )}
        </p>
        <div className="item__tag">
          <span className="code">{t('dispute.code', { code: disputeCode(d.id) })}</span>
          <span className={live ? 'stamp stamp--ink' : 'stamp'}>{f.state(d.status)}</span>
        </div>
        <h1 tabIndex={-1}>{t(`reason.${d.reason}`)}</h1>
        <p className="item__meta">
          <Link to={`/deals/${d.transactionId}`}>
            {t('dispute.onDeal', { code: dealCode(d.transactionId) })}
          </Link>
        </p>
      </header>

      <section aria-labelledby="case-facts">
        <div className="section-head">
          <h2 id="case-facts">{t('need.details')}</h2>
        </div>
        {d.description && <p className="item__desc">{d.description}</p>}
        <dl className="facts">
          <Row label={t('dispute.openedBy')}>
            {staff
              ? t(`dispute.by.${d.openedBy}`)
              : d.openedBy === d.viewerRole
                ? t('dispute.openedBy.you')
                : t('dispute.openedBy.them')}
          </Row>
          {d.amount && <Row label={t('dispute.amount')}>{f.taka(d.amount.amount)}</Row>}
          {live && <Row label={t('dispute.respondBy')}>{date(d.respondBy)}</Row>}
          {d.resolution && (
            <Row label={t('dispute.resolution')}>
              {t(`dispute.res.${d.resolution}`)}
              {d.resolutionNote && <span className="facts__aside">“{d.resolutionNote}”</span>}
            </Row>
          )}
        </dl>
        {d.respondentMissedDeadline && live && <p className="muted">{t('dispute.missed')}</p>}
      </section>

      <aside className="item__side" aria-label={t('need.details')}>
        <div className="panel">
          <div className="dispute__stamp" aria-hidden="true">
            <ScalesGlyph />
          </div>
          <PartyActions d={d} />
          <StaffPanel d={d} />
        </div>
      </aside>

      <Timeline d={d} />
    </article>
  );
}

function Timeline({ d }: { d: DisputeDetail }) {
  const { t, date, has } = useI18n();
  const f = useFormat();
  const me = useSession().account?.id;
  return (
    <section className="item__wide" aria-labelledby="case-file">
      <div className="section-head">
        <h2 id="case-file">{t('dispute.timeline')}</h2>
      </div>
      <ol className="timeline casefile">
        {[...d.timeline].reverse().map((e: Entry) => {
          const who =
            e.authorId && e.authorId === me ? t('dispute.by.you') : t(`dispute.by.${e.authorRole}`);
          const kind = has(`dispute.kind.${e.kind}`)
            ? t(`dispute.kind.${e.kind}` as 'dispute.kind.NOTE')
            : e.kind;
          return (
            <li key={e.id} data-staff={e.visibility === 'STAFF' ? '' : undefined}>
              <time className="code" dateTime={e.createdAt}>
                {date(e.createdAt)}
              </time>
              <span>
                <strong>{who}</strong> · {kind}
                {e.toStatus && ` · ${f.state(e.toStatus)}`}
                {e.visibility === 'STAFF' && (
                  <span className="stamp">{t('dispute.staffOnly')}</span>
                )}
              </span>
              {e.targetParty && (
                <span className="muted">
                  {t('dispute.toParty', {
                    party:
                      e.targetParty === 'BOTH'
                        ? t('dispute.party.BOTH')
                        : t(`dispute.by.${e.targetParty}`),
                  })}
                </span>
              )}
              {e.text && <p className="casefile__text">{e.text}</p>}
              {e.mediaIds.length > 0 && (
                <ul className="photos__grid casefile__media">
                  {e.mediaIds.map((m) => (
                    <li key={m} className="photos__item">
                      <MediaImage id={m} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function PartyActions({ d }: { d: DisputeDetail }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const intent = useIntent();
  const [statement, setStatement] = useState('');
  const [evidence, setEvidence] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string>();
  const done = (next: DisputeDetail) => {
    intent.renew();
    setStatement('');
    setEvidence('');
    setPhotos([]);
    setConfirm(false);
    qc.setQueryData(['disputes', d.id], next);
    void qc.invalidateQueries({ queryKey: ['me'] });
  };
  const run = useMutation({
    mutationFn: (
      a:
        | { kind: 'statement'; text: string }
        | { kind: 'evidence'; text: string; mediaIds: string[] }
        | { kind: 'withdraw' },
    ) =>
      a.kind === 'statement'
        ? disputesApi.statement(d.id, a.text, intent.key)
        : a.kind === 'evidence'
          ? disputesApi.evidence(
              d.id,
              {
                ...(a.text ? { text: a.text } : {}),
                ...(a.mediaIds.length ? { mediaIds: a.mediaIds } : {}),
              },
              intent.key,
            )
          : disputesApi.withdraw(d.id, intent.key),
    onSuccess: done,
  });

  if (d.viewerRole === 'STAFF') return null;
  if (d.actions.length === 0) return <p className="muted">{t('deal.noActions')}</p>;

  const sendStatement = (e: FormEvent) => {
    e.preventDefault();
    if (statement.trim().length < 10) return setError(t('common.required'));
    setError(undefined);
    run.mutate({ kind: 'statement', text: statement.trim() });
  };
  const sendEvidence = (e: FormEvent) => {
    e.preventDefault();
    if (!evidence.trim() && photos.length === 0) return setError(t('dispute.evidenceEmpty'));
    setError(undefined);
    run.mutate({ kind: 'evidence', text: evidence.trim(), mediaIds: photos });
  };

  return (
    <div className="item__actions">
      {d.actions.includes('statement') && (
        <form className="counter" onSubmit={sendStatement} noValidate>
          <TextAreaField
            label={t('dispute.statement')}
            hint={t('dispute.statementHint')}
            value={statement}
            onChange={setStatement}
            maxLength={4000}
            rows={5}
          />
          <button type="submit" className="btn btn--small" disabled={run.isPending}>
            {t('dispute.statementSend')}
          </button>
        </form>
      )}
      {d.actions.includes('evidence') && (
        <form className="counter" onSubmit={sendEvidence} noValidate>
          <h3>{t('dispute.evidence')}</h3>
          <TextAreaField
            label={t('dispute.evidenceText')}
            optional
            value={evidence}
            onChange={setEvidence}
            maxLength={2000}
            rows={3}
          />
          <PhotoPicker purpose="DISPUTE" value={photos} onChange={setPhotos} max={10} />
          <button type="submit" className="btn btn--outline btn--small" disabled={run.isPending}>
            {t('dispute.evidenceSend')}
          </button>
        </form>
      )}
      {d.actions.includes('withdraw') &&
        (confirm ? (
          <div className="ledger__confirm" role="group" aria-label={t('dispute.withdraw')}>
            <p>{t('dispute.withdrawConfirm')}</p>
            <button
              type="button"
              className="btn btn--danger btn--small"
              disabled={run.isPending}
              onClick={() => run.mutate({ kind: 'withdraw' })}
            >
              {t('dispute.withdrawYes')}
            </button>
            <button
              type="button"
              className="btn btn--outline btn--small"
              onClick={() => setConfirm(false)}
            >
              {t('common.keep')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn--danger btn--small"
            onClick={() => setConfirm(true)}
          >
            {t('dispute.withdraw')}
          </button>
        ))}
      {(error || run.isError) && (
        <p className="alert" role="alert">
          <AlertIcon />
          <span>{error ?? errorMessage(run.error, t)}</span>
        </p>
      )}
    </div>
  );
}
