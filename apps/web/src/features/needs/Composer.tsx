import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { AlertIcon } from '../../components/glyphs/glyphs';
import { useI18n } from '../../lib/i18n';
import { useSession } from '../auth/session';
import { loadDraft, saveDraft, type ComposerDraft } from './draft';
import { ModeKey } from './ModeKey';

/**
 * "What do you need?" — the primary action. The words are kept on the device and carried into
 * the full need form, through sign-in if needed.
 */
export function Composer() {
  const { t } = useI18n();
  const { status } = useSession();
  const navigate = useNavigate();
  const fieldId = useId();
  const hintId = useId();
  const [draft, setDraft] = useState<ComposerDraft>(loadDraft);
  const [notice, setNotice] = useState<'empty' | null>(null);

  useEffect(() => saveDraft(draft), [draft]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.text.trim()) {
      setNotice('empty');
      document.getElementById(fieldId)?.focus();
      return;
    }
    if (status !== 'signedIn') {
      void navigate('/sign-in', { state: { from: '/needs/new', reason: 'post' } });
      return;
    }
    void navigate('/needs/new');
  };

  return (
    <form className="composer" id="post" onSubmit={submit} noValidate>
      <ModeKey value={draft.mode} onChange={(mode) => setDraft((d) => ({ ...d, mode }))} />

      <div className="field" data-invalid={notice === 'empty' ? '' : undefined}>
        <label className="label" htmlFor={fieldId}>
          {t('home.field')}
        </label>
        <div className="field__control">
          <textarea
            id={fieldId}
            name="need"
            maxLength={600}
            value={draft.text}
            placeholder={t(`mode.${draft.mode}.example`)}
            aria-describedby={hintId}
            aria-invalid={notice === 'empty'}
            onChange={(e) => {
              setDraft((d) => ({ ...d, text: e.target.value }));
              if (notice) setNotice(null);
            }}
          />
        </div>
        <p className="field__hint" id={hintId}>
          {t('home.hint')}
        </p>
      </div>

      {notice === 'empty' && (
        <p className="alert" role="alert">
          <AlertIcon />
          <span>{t('home.empty')}</span>
        </p>
      )}

      <div className="composer__actions">
        <button type="submit" className="btn btn--block">
          {t('home.post')}
        </button>
        <Link className="btn btn--outline" to="/listings">
          {t('home.browse')}
        </Link>
      </div>
      {status === 'signedOut' && <p className="field__hint">{t('home.signInToPost')}</p>}
    </form>
  );
}
