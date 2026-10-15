import { AccountStatuses, type AccountStatus } from '@dorkar/contracts';
import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { SelectField, TextAreaField, TextField } from '../../components/forms/fields';
import { AlertIcon, NoteIcon } from '../../components/glyphs/glyphs';
import { useSession } from '../../features/auth/session';
import { deskApi } from '../../features/desk/api';
import { DeskCrumb, StaffPage } from '../../features/desk/tools';
import { useProfile } from '../../features/trust/UserLink';
import { errorMessage } from '../../lib/errors';
import { shortCode } from '../../lib/format';
import { useI18n } from '../../lib/i18n';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function AccountsRoute() {
  return (
    <StaffPage needs="user:suspend" from="/desk/accounts">
      <Accounts />
    </StaffPage>
  );
}

function Accounts() {
  const { t } = useI18n();
  const me = useSession().account?.id;
  const [params] = useSearchParams();
  const [id, setId] = useState(params.get('id') ?? '');
  const [status, setStatus] = useState<AccountStatus>('SUSPENDED');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const valid = UUID.test(id.trim());
  const profile = useProfile(valid ? id.trim() : undefined);
  const change = useMutation({
    mutationFn: () => deskApi.setAccountStatus(id.trim(), status, reason.trim()),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs = {
      id: !valid ? t('log.invalidId') : id.trim() === me ? t('acct.self') : undefined,
      reason: reason.trim().length < 3 ? t('staff.reasonHint') : undefined,
    };
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) return;
    change.mutate();
  };

  return (
    <div className="formpage">
      <header className="desk__head">
        <DeskCrumb />
        <h1 tabIndex={-1}>{t('acct.title')}</h1>
        <p className="desk__lede">{t('acct.lede')}</p>
      </header>
      <form className="formsec" onSubmit={submit} noValidate>
        <TextField
          label={t('acct.id')}
          hint={t('acct.idHint')}
          value={id}
          onChange={(v) => {
            setId(v);
            change.reset();
          }}
          maxLength={36}
          error={errors['id']}
        />
        {profile.data && (
          <p className="muted">
            {profile.data.displayName} ·{' '}
            <Link to={`/users/${profile.data.id}`}>{t('acct.view')}</Link>
          </p>
        )}
        <SelectField
          label={t('acct.status')}
          value={status}
          onChange={(v) => setStatus(v as AccountStatus)}
          options={AccountStatuses.map((s) => ({ value: s, label: t(`account.status.${s}`) }))}
        />
        <TextAreaField
          label={t('staff.reason')}
          hint={t('staff.reasonHint')}
          value={reason}
          onChange={setReason}
          maxLength={500}
          rows={3}
          error={errors['reason']}
        />
        {change.isSuccess && (
          <p className="alert alert--note" role="status">
            <NoteIcon />
            <span>
              {t('acct.done', {
                code: shortCode('M', change.data.id),
                status: t(`account.status.${change.data.status}`),
              })}
            </span>
          </p>
        )}
        {change.isError && (
          <p className="alert" role="alert">
            <AlertIcon />
            <span>{errorMessage(change.error, t)}</span>
          </p>
        )}
        <div className="formactions">
          <button
            type="submit"
            className={status === 'ACTIVE' ? 'btn' : 'btn btn--danger'}
            disabled={change.isPending}
          >
            {t('acct.apply')}
          </button>
        </div>
      </form>
    </div>
  );
}
