import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { Segmented, TextField } from '../../components/forms/fields';
import { AlertIcon } from '../../components/glyphs/glyphs';
import { MoreButton, usePaged } from '../../components/ui/Paging';
import { LedgerSkeleton, LoadError } from '../../components/ui/Status';
import { deskApi, type AdminVerification } from '../../features/desk/api';
import { DeskCrumb, StaffPage } from '../../features/desk/tools';
import { errorMessage } from '../../lib/errors';
import { shortCode, useFormat } from '../../lib/format';
import { useI18n } from '../../lib/i18n';

const STATES = ['PENDING', 'VERIFIED', 'REJECTED'] as const;

export default function VerificationsRoute() {
  return (
    <StaffPage needs="verification:nid:decide" from="/desk/verifications">
      <Queue />
    </StaffPage>
  );
}

function Queue() {
  const { t } = useI18n();
  const f = useFormat();
  const [status, setStatus] = useState<(typeof STATES)[number]>('PENDING');
  const list = usePaged(['desk', 'verifications', status], (cursor) =>
    deskApi.verifications(status, cursor),
  );
  return (
    <div className="browse">
      <header className="desk__head">
        <DeskCrumb />
        <h1 tabIndex={-1}>{t('ver.title')}</h1>
        <p className="desk__lede">{t('ver.lede')}</p>
      </header>
      <section aria-labelledby="ver-list">
        <div className="section-head">
          <h2 id="ver-list">{t('ver.title')}</h2>
        </div>
        <Segmented
          legend={t('ver.status')}
          hideLegend
          name="ver-status"
          value={status}
          onChange={setStatus}
          options={STATES.map((s) => ({ value: s, label: f.state(s) }))}
        />
        {list.isPending && <LedgerSkeleton rows={3} />}
        {list.isError && <LoadError onRetry={() => void list.refetch()} />}
        {list.data && list.rows.length === 0 && <p className="muted">{t('ver.empty')}</p>}
        {list.rows.length > 0 && (
          <ul className="ledger verlist">
            {list.rows.map((v) => (
              <Row key={v.id} v={v} />
            ))}
          </ul>
        )}
        <MoreButton query={list} />
      </section>
    </div>
  );
}

function Row({ v }: { v: AdminVerification }) {
  const { t, date } = useI18n();
  const f = useFormat();
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  const decide = useMutation({
    mutationFn: (d: 'VERIFIED' | 'REJECTED') => deskApi.decideVerification(v.id, d, note.trim()),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['desk', 'verifications'] }),
  });
  const go = (d: 'VERIFIED' | 'REJECTED') => {
    if (!note.trim()) return setError(t('common.required'));
    setError(undefined);
    decide.mutate(d);
  };
  return (
    <li>
      <span className="ledger__art code">{v.nidLast4 ?? '—'}</span>
      <div>
        <Link className="ledger__title" to={`/users/${v.accountId}`}>
          {t('ver.account')} {shortCode('M', v.accountId)}
        </Link>
        <p className="ledger__meta">
          {[
            t(`verify.kind.${v.kind}`),
            f.state(v.status),
            t('ver.submitted', { when: date(v.submittedAt) }),
            t('ver.provider', { provider: v.provider }),
            v.reviewNote && `“${v.reviewNote}”`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {v.status === 'PENDING' && (
          <div className="verlist__decide">
            <TextField
              compact
              label={t('ver.note')}
              value={note}
              onChange={setNote}
              maxLength={500}
              error={error}
            />
            <div className="formactions">
              <button
                type="button"
                className="btn btn--small"
                disabled={decide.isPending}
                onClick={() => go('VERIFIED')}
              >
                {t('ver.approve')}
              </button>
              <button
                type="button"
                className="btn btn--danger btn--small"
                disabled={decide.isPending}
                onClick={() => go('REJECTED')}
              >
                {t('ver.reject')}
              </button>
            </div>
            {decide.isError && (
              <p className="alert" role="alert">
                <AlertIcon />
                <span>{errorMessage(decide.error, t)}</span>
              </p>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
