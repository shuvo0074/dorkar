import { findContactInfo } from '@dorkar/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { TextAreaField } from '../components/forms/fields';
import { AlertIcon, NoteIcon } from '../components/glyphs/glyphs';
import { LedgerSkeleton, LoadError, SignedInOnly } from '../components/ui/Status';
import { useSession } from '../features/auth/session';
import { chatApi, type Conversation } from '../features/messages/api';
import { contextLink } from '../features/messages/MessageButton';
import { useThread, type Outgoing } from '../features/messages/useThread';
import { useProfile } from '../features/trust/UserLink';
import { ApiError } from '../lib/http';
import { errorMessage, ruleOf } from '../lib/errors';
import { shortCode } from '../lib/format';
import { useI18n } from '../lib/i18n';
import NotFoundRoute from './NotFoundRoute';

export default function ConversationRoute() {
  const { id = '' } = useParams();
  return (
    <SignedInOnly from={`/messages/${id}`}>
      <Loader id={id} />
    </SignedInOnly>
  );
}

function Loader({ id }: { id: string }) {
  const convo = useQuery({ queryKey: ['me', 'conversations', id], queryFn: () => chatApi.get(id) });
  if (convo.isPending) return <LedgerSkeleton rows={5} />;
  if (convo.error instanceof ApiError && convo.error.status === 404) return <NotFoundRoute />;
  if (convo.isError) return <LoadError onRetry={() => void convo.refetch()} />;
  return <Thread convo={convo.data} />;
}

function sendProblem(err: unknown, t: ReturnType<typeof useI18n>['t']) {
  if (ruleOf(err) === 'CONTACT_INFO_NOT_ALLOWED') return t('chat.contact');
  if (err instanceof ApiError && err.code === 'FORBIDDEN') return t('chat.blocked');
  return errorMessage(err, t);
}

function Thread({ convo }: { convo: Conversation }) {
  const { t, date } = useI18n();
  const me = useSession().account?.id;
  const qc = useQueryClient();
  const other = useProfile(convo.otherParticipantId);
  const thread = useThread(convo.id);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string>();
  const end = useRef<HTMLDivElement>(null);
  const name =
    other.data?.displayName ??
    t('common.member', { code: shortCode('M', convo.otherParticipantId) });

  const last = thread.messages.at(-1);
  // Mark read once the newest message is someone else's and on screen.
  useEffect(() => {
    if (!last || last.senderId === me) return;
    void chatApi.read(convo.id, last.id).then(() => {
      void qc.invalidateQueries({ queryKey: ['me', 'unread'] });
      void qc.invalidateQueries({ queryKey: ['me', 'conversations'], exact: false });
    });
  }, [last, me, convo.id, qc]);

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [thread.messages.length, thread.outgoing.length]);

  const failed = thread.outgoing.find((o) => o.status === 'failed');
  useEffect(() => {
    if (failed) setProblem(sendProblem(failed.error, t));
  }, [failed, t]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    if (findContactInfo(body)) return setProblem(t('chat.contact'));
    setProblem(undefined);
    setDraft('');
    void thread.send(body);
  };

  return (
    <div className="chat">
      <header className="desk__head">
        <p className="crumb">
          <Link to="/messages">{t('chat.title')}</Link>
        </p>
        <h1 tabIndex={-1}>{t('chat.with', { name })}</h1>
        <p className="desk__meta">
          <span>{t(`chat.about.${convo.context.type}`)}</span>
          <Link to={contextLink(convo.context.type, convo.context.id)}>{t('chat.open')}</Link>
          <Link to={`/users/${convo.otherParticipantId}`}>{t('profile.view')}</Link>
        </p>
      </header>

      <section className="chat__log" aria-label={t('chat.title')} aria-live="polite">
        {thread.loadError ? (
          <LoadError onRetry={() => location.reload()} />
        ) : !thread.loaded ? (
          <LedgerSkeleton rows={4} />
        ) : (
          <>
            {thread.older && (
              <button type="button" className="linkbtn" onClick={() => void thread.loadOlder()}>
                {t('chat.older')}
              </button>
            )}
            {thread.messages.length === 0 && thread.outgoing.length === 0 && (
              <p className="muted">{t('chat.noMessages')}</p>
            )}
            <ol className="chat__lines">
              {thread.messages.map((m) => {
                const mine = m.senderId === me;
                return (
                  <li key={m.id} className={mine ? 'chat__line chat__line--mine' : 'chat__line'}>
                    <span className="chat__who">
                      {mine ? t('chat.you') : name} ·{' '}
                      <time dateTime={m.createdAt}>{date(m.createdAt)}</time>
                    </span>
                    <p className={m.removed ? 'muted' : undefined}>
                      {m.removed ? t('chat.removed') : m.body}
                    </p>
                  </li>
                );
              })}
              {thread.outgoing.map((o: Outgoing) => (
                <li key={o.clientId} className="chat__line chat__line--mine chat__line--pending">
                  <span className="chat__who">
                    {t('chat.you')} · {o.status === 'sending' ? t('chat.sending') : ''}
                  </span>
                  <p>{o.body}</p>
                  {o.status === 'failed' && (
                    <button
                      type="button"
                      className="linkbtn"
                      onClick={() => void thread.send(o.body, o.clientId)}
                    >
                      {t('chat.failed')}
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </>
        )}
        <div ref={end} />
      </section>

      <form className="chat__compose" onSubmit={submit} noValidate>
        <TextAreaField
          label={t('chat.write')}
          hint={t('chat.writeHint')}
          value={draft}
          onChange={(v) => {
            setDraft(v);
            if (problem) setProblem(undefined);
          }}
          maxLength={2000}
          rows={3}
        />
        {problem && (
          <p className="alert" role="alert">
            <AlertIcon />
            <span>{problem}</span>
          </p>
        )}
        <div className="formactions">
          <button type="submit" className="btn" disabled={!draft.trim()}>
            {t('chat.send')}
          </button>
        </div>
      </form>

      <Block userId={convo.otherParticipantId} />
    </div>
  );
}

function Block({ userId }: { userId: string }) {
  const { t } = useI18n();
  const [confirm, setConfirm] = useState(false);
  const block = useMutation({ mutationFn: () => chatApi.block(userId) });
  if (block.isSuccess)
    return (
      <p className="alert alert--note">
        <NoteIcon />
        <span>{t('chat.blockedDone')}</span>
      </p>
    );
  return (
    <div className="report">
      {!confirm ? (
        <button type="button" className="linkbtn" onClick={() => setConfirm(true)}>
          {t('chat.block')}
        </button>
      ) : (
        <div className="ledger__confirm" role="group" aria-label={t('chat.block')}>
          <p>{t('chat.blockConfirm')}</p>
          <button
            type="button"
            className="btn btn--danger btn--small"
            disabled={block.isPending}
            onClick={() => block.mutate()}
          >
            {t('chat.blockYes')}
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
    </div>
  );
}
