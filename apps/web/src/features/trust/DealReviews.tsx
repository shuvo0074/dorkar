import { findContactInfo } from '@dorkar/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Segmented, TextAreaField } from '../../components/forms/fields';
import { AlertIcon, NoteIcon } from '../../components/glyphs/glyphs';
import { LedgerSkeleton } from '../../components/ui/Status';
import { errorMessage, ruleOf } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { useSession } from '../auth/session';
import { trustApi, type PublicReview } from './api';

/** Five printed squares, the rating's worth filled with ink. */
export function Rating({ value }: { value: number }) {
  const { t } = useI18n();
  return (
    <span className="rating" role="img" aria-label={t('review.star', { n: value })}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={n <= Math.round(value) ? 'rating__on' : undefined} />
      ))}
    </span>
  );
}

export function ReviewItem({ review, heading }: { review: PublicReview; heading?: string }) {
  const { t, date } = useI18n();
  return (
    <li className="review">
      <div className="review__head">
        <Rating value={review.rating} />
        <span className="muted">
          {heading ?? t(`review.by.${review.authorRole}`)} · {date(review.createdAt, 'short')}
        </span>
      </div>
      {review.comment && <p>{review.comment}</p>}
    </li>
  );
}

/** On a completed deal: each side's review, and the form for whoever hasn't written one. */
export function DealReviews({ transactionId }: { transactionId: string }) {
  const { t } = useI18n();
  const me = useSession().account?.id;
  const reviews = useQuery({
    queryKey: ['deals', transactionId, 'reviews'],
    queryFn: () => trustApi.dealReviews(transactionId),
  });
  const mine = reviews.data?.find((r) => r.authorId === me);
  const theirs = reviews.data?.find((r) => r.authorId !== me);

  return (
    <section className="item__wide" aria-labelledby="reviews-title">
      <div className="section-head">
        <h2 id="reviews-title">{t('reviews.title')}</h2>
      </div>
      {reviews.isPending && <LedgerSkeleton rows={2} />}
      {reviews.data && (
        <>
          {(mine || theirs) && (
            <ul className="reviews">
              {mine && <ReviewItem review={mine} heading={t('review.yours')} />}
              {theirs && <ReviewItem review={theirs} heading={t('review.theirs')} />}
            </ul>
          )}
          {!mine && <ReviewForm transactionId={transactionId} />}
        </>
      )}
    </section>
  );
}

function ReviewForm({ transactionId }: { transactionId: string }) {
  const { t, num } = useI18n();
  const qc = useQueryClient();
  const [rating, setRating] = useState<'' | '1' | '2' | '3' | '4' | '5'>('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string>();
  const send = useMutation({
    mutationFn: () => trustApi.review(transactionId, Number(rating), comment.trim() || null),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['deals', transactionId, 'reviews'] }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!rating) return setError(t('review.pick'));
    if (findContactInfo(comment)) return setError(t('needForm.contact'));
    setError(undefined);
    send.mutate();
  };

  const closed = ruleOf(send.error) === 'REVIEW_WINDOW_CLOSED';
  return (
    <form className="formsec reviewform" onSubmit={submit} noValidate>
      <h3>{t('review.title')}</h3>
      <p className="muted">{t('review.lede')}</p>
      <Segmented
        legend={t('review.rating')}
        name="review-rating"
        value={rating}
        onChange={setRating}
        options={(['1', '2', '3', '4', '5'] as const).map((n) => ({
          value: n,
          label: num(Number(n)),
        }))}
      />
      <TextAreaField
        label={t('review.comment')}
        optional
        hint={t('review.commentHint')}
        value={comment}
        onChange={setComment}
        maxLength={1000}
        rows={3}
      />
      {(error || send.isError) && (
        <p className="alert" role="alert">
          <AlertIcon />
          <span>{error ?? (closed ? t('review.closed') : errorMessage(send.error, t))}</span>
        </p>
      )}
      {send.isSuccess && (
        <p className="alert alert--note" role="status">
          <NoteIcon />
          <span>{t('review.thanks')}</span>
        </p>
      )}
      <div className="formactions">
        <button type="submit" className="btn" disabled={send.isPending}>
          {t('review.send')}
        </button>
      </div>
    </form>
  );
}
