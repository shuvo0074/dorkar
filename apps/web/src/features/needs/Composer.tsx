import { useEffect, useId, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { AlertIcon, NoteIcon } from '../../components/glyphs/glyphs';
import { useI18n } from '../../lib/i18n';
import { useSession } from '../auth/session';
import { ModeKey } from './ModeKey';
import { Modes, type Mode } from './modes';

const DRAFT_KEY = 'dorkar.needDraft';

interface Draft {
  mode: Mode;
  text: string;
}

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Draft>) : {};
    return {
      mode: Modes.includes(parsed.mode as Mode) ? (parsed.mode as Mode) : 'BUY',
      text: typeof parsed.text === 'string' ? parsed.text.slice(0, 600) : '',
    };
  } catch {
    return { mode: 'BUY', text: '' };
  }
}

function saveDraft(d: Draft) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    // a draft is a convenience; losing it is acceptable
  }
}

/**
 * "What do you need?" — the primary action. Posting itself ships with the demand service; until
 * then the composer keeps an honest draft on the device and says so, rather than faking a post.
 */
export function Composer() {
  const { t } = useI18n();
  const { status } = useSession();
  const navigate = useNavigate();
  const fieldId = useId();
  const hintId = useId();
  const [draft, setDraft] = useState<Draft>(loadDraft);
  const [notice, setNotice] = useState<'empty' | 'saved' | null>(null);

  useEffect(() => saveDraft(draft), [draft]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.text.trim()) {
      setNotice('empty');
      document.getElementById(fieldId)?.focus();
      return;
    }
    if (status !== 'signedIn') {
      void navigate('/sign-in', { state: { from: '/', reason: 'post' } });
      return;
    }
    setNotice('saved');
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
      {notice === 'saved' && (
        <p className="alert alert--note" role="status">
          <NoteIcon />
          <span>{t('home.draftSaved')}</span>
        </p>
      )}

      <div className="composer__actions">
        <button type="submit" className="btn btn--block">
          {t('home.post')}
        </button>
        <button
          type="button"
          className="btn btn--outline"
          disabled
          aria-describedby={`${hintId}-soon`}
        >
          {t('home.browse')}
          <span className="tag" id={`${hintId}-soon`}>
            {t('home.soon')}
          </span>
        </button>
      </div>
      {status === 'signedOut' && <p className="field__hint">{t('home.signInToPost')}</p>}
    </form>
  );
}
