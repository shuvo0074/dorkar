import { findContactInfo } from '@dorkar/contracts';
import { trustApi, type PublicReview } from '@web/features/trust/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { c, r } from '../../design/tokens';
import { errorMessage, ruleOf } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { Button } from '../../ui/Button';
import { Chips, FieldShell, TextAreaField } from '../../ui/Fields';
import { Alert, Card, Row, Section } from '../../ui/Layout';
import { Skeleton } from '../../ui/Misc';
import { T } from '../../ui/Text';
import { useSession } from '../auth/session';

/** Five marks, the rating's worth filled in. */
export function Rating({ value }: { value: number }) {
  const { t } = useI18n();
  return (
    <View
      style={styles.rating}
      accessible
      accessibilityRole="image"
      accessibilityLabel={t('review.star', { n: value })}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <View key={n} style={[styles.mark, n <= Math.round(value) && styles.markOn]} />
      ))}
    </View>
  );
}

export function ReviewItem({ review, heading }: { review: PublicReview; heading?: string }) {
  const { t, date } = useI18n();
  return (
    <View style={styles.review}>
      <Row>
        <Rating value={review.rating} />
        <T v="small" color={c.inkSoft}>
          {heading ?? t(`review.by.${review.authorRole}`)} · {date(review.createdAt, 'short')}
        </T>
      </Row>
      {review.comment ? <T>{review.comment}</T> : null}
    </View>
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
  const mine = reviews.data?.find((x) => x.authorId === me);
  const theirs = reviews.data?.find((x) => x.authorId !== me);

  return (
    <Section title={t('reviews.title')}>
      {reviews.isPending ? <Skeleton rows={2} /> : null}
      {reviews.data ? (
        <>
          {mine ? <ReviewItem review={mine} heading={t('review.yours')} /> : null}
          {theirs ? <ReviewItem review={theirs} heading={t('review.theirs')} /> : null}
          {!mine ? <ReviewForm transactionId={transactionId} /> : null}
        </>
      ) : null}
    </Section>
  );
}

function ReviewForm({ transactionId }: { transactionId: string }) {
  const { t, num } = useI18n();
  const qc = useQueryClient();
  const [rating, setRating] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string>();
  const send = useMutation({
    mutationFn: () => trustApi.review(transactionId, Number(rating), comment.trim() || null),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['deals', transactionId, 'reviews'] }),
  });

  const submit = () => {
    if (!rating) return setError(t('review.pick'));
    if (findContactInfo(comment)) return setError(t('needForm.contact'));
    setError(undefined);
    send.mutate();
  };

  const closed = ruleOf(send.error) === 'REVIEW_WINDOW_CLOSED';
  return (
    <Card>
      <T v="section" accessibilityRole="header">
        {t('review.title')}
      </T>
      <T color={c.inkSoft}>{t('review.lede')}</T>
      <FieldShell label={t('review.rating')}>
        <Chips
          label={t('review.rating')}
          value={rating}
          onChange={setRating}
          options={['1', '2', '3', '4', '5'].map((n) => ({ value: n, label: num(Number(n)) }))}
        />
      </FieldShell>
      <TextAreaField
        label={t('review.comment')}
        optional
        hint={t('review.commentHint')}
        value={comment}
        onChange={setComment}
        maxLength={1000}
      />
      {error || send.isError ? (
        <Alert message={error ?? (closed ? t('review.closed') : errorMessage(send.error, t))} />
      ) : null}
      {send.isSuccess ? <Alert tone="info" message={t('review.thanks')} /> : null}
      <Button block busy={send.isPending} label={t('review.send')} onPress={submit} />
    </Card>
  );
}

const styles = StyleSheet.create({
  rating: { flexDirection: 'row', gap: 3 },
  mark: { width: 12, height: 12, borderRadius: r.chip, backgroundColor: c.paperShade },
  markOn: { backgroundColor: c.brand },
  review: { gap: 6 },
});
