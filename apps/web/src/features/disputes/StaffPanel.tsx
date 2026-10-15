import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { SelectField, TextAreaField } from '../../components/forms/fields';
import { AlertIcon, NoteIcon } from '../../components/glyphs/glyphs';
import { errorMessage } from '../../lib/errors';
import { shortCode } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { useIntent } from '../../lib/useIntent';
import { useSession } from '../auth/session';
import { disputesApi, type DisputeDetail, type Resolution } from './api';

type Open = 'note' | 'request-info' | 'resolve' | null;

/** Staff actions on a dispute: assign, note, ask a party, resolve. Driven by `actions`. */
export function StaffPanel({ d }: { d: DisputeDetail }) {
  const { t } = useI18n();
  const me = useSession().account?.id;
  const qc = useQueryClient();
  const intent = useIntent();
  const [open, setOpen] = useState<Open>(null);
  const [text, setText] = useState('');
  const [party, setParty] = useState<'BUYER' | 'SELLER' | 'BOTH'>('BOTH');
  const [resolution, setResolution] = useState<Resolution>('RELEASE');
  const [error, setError] = useState<string>();
  const done = (next: DisputeDetail) => {
    intent.renew();
    setOpen(null);
    setText('');
    qc.setQueryData(['disputes', d.id], next);
    void qc.invalidateQueries({ queryKey: ['desk', 'disputes'] });
  };
  const run = useMutation({
    mutationFn: (kind: 'assign' | Exclude<Open, null>) => {
      switch (kind) {
        case 'assign':
          return disputesApi.assign(d.id, 'me', intent.key);
        case 'note':
          return disputesApi.note(d.id, text.trim(), intent.key);
        case 'request-info':
          return disputesApi.requestInfo(d.id, party, text.trim(), intent.key);
        case 'resolve':
          return disputesApi.resolve(d.id, resolution, text.trim(), intent.key);
      }
    },
    onSuccess: done,
  });

  if (d.viewerRole !== 'STAFF') return null;
  const assigned = d.staff?.assignedTo;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!open) return;
    const min = open === 'note' ? 1 : 3;
    if (text.trim().length < min) return setError(t('common.required'));
    setError(undefined);
    run.mutate(open);
  };

  return (
    <div className="item__actions">
      <p className="label">{t('sdisp.panel')}</p>
      <p className="muted">
        {assigned
          ? t('staff.assigned', {
              who: assigned === me ? t('staff.you') : shortCode('M', assigned),
            })
          : t('staff.unassigned')}
      </p>
      {open === null && (
        <>
          {d.actions.includes('assign') && assigned !== me && (
            <button
              type="button"
              className="btn btn--outline btn--small"
              disabled={run.isPending}
              onClick={() => run.mutate('assign')}
            >
              {t('staff.assignMe')}
            </button>
          )}
          {d.actions.includes('note') && (
            <button
              type="button"
              className="btn btn--outline btn--small"
              onClick={() => setOpen('note')}
            >
              {t('sdisp.addNote')}
            </button>
          )}
          {d.actions.includes('request-info') && (
            <button
              type="button"
              className="btn btn--outline btn--small"
              onClick={() => setOpen('request-info')}
            >
              {t('sdisp.ask')}
            </button>
          )}
          {d.actions.includes('resolve') && (
            <button type="button" className="btn btn--small" onClick={() => setOpen('resolve')}>
              {t('sdisp.resolve')}
            </button>
          )}
        </>
      )}
      {open && (
        <form className="counter" onSubmit={submit} noValidate>
          {open === 'request-info' && (
            <SelectField
              label={t('sdisp.askParty')}
              value={party}
              onChange={(v) => setParty(v as typeof party)}
              options={[
                { value: 'BOTH', label: t('dispute.party.BOTH') },
                { value: 'BUYER', label: t('dispute.by.BUYER') },
                { value: 'SELLER', label: t('dispute.by.SELLER') },
              ]}
            />
          )}
          {open === 'resolve' && (
            <>
              <SelectField
                label={t('sdisp.resolution')}
                value={resolution}
                onChange={(v) => setResolution(v as Resolution)}
                options={(['RELEASE', 'CANCEL', 'REFUND'] as const).map((r) => ({
                  value: r,
                  label: t(`dispute.res.${r}`),
                }))}
              />
              <p className="alert alert--note">
                <NoteIcon />
                <span>{t('sdisp.resolveConfirm')}</span>
              </p>
            </>
          )}
          <TextAreaField
            label={t(
              open === 'note'
                ? 'sdisp.note'
                : open === 'resolve'
                  ? 'sdisp.resolveNote'
                  : 'sdisp.askMessage',
            )}
            hint={open === 'note' ? t('sdisp.noteHint') : undefined}
            value={text}
            onChange={setText}
            maxLength={open === 'note' ? 4000 : 2000}
            rows={4}
            error={error}
          />
          <div className="formactions">
            <button type="submit" className="btn btn--small" disabled={run.isPending}>
              {t(
                open === 'note'
                  ? 'sdisp.addNote'
                  : open === 'resolve'
                    ? 'sdisp.resolveSend'
                    : 'sdisp.askSend',
              )}
            </button>
            <button
              type="button"
              className="btn btn--outline btn--small"
              onClick={() => setOpen(null)}
            >
              {t('common.cancel')}
            </button>
          </div>
        </form>
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
