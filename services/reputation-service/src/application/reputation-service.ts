import {
  ReputationEvents,
  type EventEnvelope,
  type ModerationEvents,
  type TransactionEvents,
} from '@dorkar/contracts';
import {
  Errors,
  paginate,
  systemContext,
  uuidv7,
  type Cursor,
  type RequestContext,
  type ServiceRuntime,
} from '@dorkar/kernel';
import type { z } from 'zod';
import {
  assertNoContactInfo,
  isParty,
  reviewEligibility,
  type Review,
  type ReviewStatus,
} from '../domain/review';
import { affectedAccounts, computeSignals, type ReputationSignals } from '../domain/signals';
import type { ReputationStore, ReputationUnitOfWork } from './ports';

export interface ReputationPolicy {
  /** Days after completion during which a party may review the other. */
  reviewWindowDays: number;
  /** Most recent reviews per (author, subject) pair that count towards the average. */
  reviewPairCap: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

type Ctx = Pick<RequestContext, 'requestId' | 'correlationId' | 'ipHash' | 'actor'>;

const requireActor = (ctx: RequestContext) => {
  if (!ctx.actor) throw Errors.unauthenticated();
  return ctx.actor;
};

const reviewKey = (r: Review): Cursor => ({ k: r.createdAt.toISOString(), id: r.id });

/** Context for work triggered by another service's event (correlates with the envelope). */
const eventContext = (e: EventEnvelope): Ctx => ({
  ...systemContext(e.id),
  correlationId: e.correlationId ?? e.id,
});

/** Review and reputation use cases. Each mutation writes state, events and audit in one transaction. */
export class ReputationService {
  constructor(
    private readonly uow: ReputationUnitOfWork,
    private readonly event: ServiceRuntime<never>['event'],
    private readonly policy: ReputationPolicy,
  ) {}

  async createReview(
    transactionId: string,
    input: { rating: number; comment?: string | null | undefined },
    ctx: RequestContext,
  ): Promise<Review> {
    const actor = requireActor(ctx);
    const comment = input.comment?.trim() ? input.comment.trim() : null;
    return this.uow.transaction(async (s) => {
      const { tx, now } = await s.transaction(transactionId);
      const { subjectId, authorRole } = reviewEligibility(
        tx,
        actor.id,
        now,
        this.policy.reviewWindowDays,
      );
      assertNoContactInfo('review', comment);
      const review = await s.insertReview({
        id: uuidv7(),
        transactionId,
        authorId: actor.id,
        subjectId,
        authorRole,
        rating: input.rating,
        comment,
      });
      if (!review) {
        throw Errors.conflict('You have already reviewed this transaction.', {
          rule: 'ONE_REVIEW_PER_PARTY',
        });
      }
      await s.outbox(
        this.event(
          ReputationEvents.ReviewCreated,
          review.id,
          {
            reviewId: review.id,
            transactionId,
            authorId: actor.id,
            subjectId,
            rating: review.rating,
          },
          ctx,
        ),
      );
      await this.recompute(s, [subjectId], ctx);
      await s.audit(ctx, {
        action: 'review.create',
        targetType: 'REVIEW',
        targetId: review.id,
        metadata: { transactionId, subjectId, rating: review.rating },
      });
      return review;
    });
  }

  /** Both parties' reviews of one transaction; only parties may look. */
  async transactionReviews(transactionId: string, ctx: RequestContext): Promise<Review[]> {
    const actor = requireActor(ctx);
    const { tx } = await this.uow.store.transaction(transactionId);
    if (!tx || !isParty(tx, actor.id)) throw Errors.notFound('Transaction');
    return this.uow.store.reviewsForTransaction(transactionId);
  }

  async publicReviews(
    userId: string,
    q: { cursor: Cursor | null; limit: number },
  ): Promise<Page<Review> & { summary: ReputationSignals }> {
    const [rows, summary] = await Promise.all([
      this.uow.store.visibleReviewsAbout(userId, q.cursor, q.limit),
      this.uow.store.signals(userId),
    ]);
    return { ...paginate(rows, q.limit, reviewKey), summary };
  }

  async adminReviews(q: {
    status: ReviewStatus | null;
    cursor: Cursor | null;
    limit: number;
  }): Promise<Page<Review>> {
    return paginate(await this.uow.store.reviews(q.status, q.cursor, q.limit), q.limit, reviewKey);
  }

  // ---- event handlers (called inside the inbox transaction) ----

  async onTransactionCreated(
    s: ReputationStore,
    p: z.output<(typeof TransactionEvents)['TransactionCreated']['schema']>,
    e: EventEnvelope,
  ): Promise<void> {
    await s.recordTransactionCreated({
      id: p.transactionId,
      buyerId: p.buyerId,
      sellerId: p.sellerId,
      mode: p.mode,
      amount: p.amount.amount,
      currency: p.amount.currency,
      at: new Date(e.occurredAt),
    });
  }

  async onTransactionStateChanged(
    s: ReputationStore,
    p: z.output<(typeof TransactionEvents)['TransactionStateChanged']['schema']>,
    e: EventEnvelope,
  ): Promise<void> {
    await s.recordStateChange({
      id: p.transactionId,
      buyerId: p.buyerId,
      sellerId: p.sellerId,
      to: p.to,
      actorId: p.actorId,
      at: new Date(e.occurredAt),
    });
    const affected = affectedAccounts(p.to, p.buyerId, p.sellerId, p.actorId);
    if (affected.length) await this.recompute(s, affected, eventContext(e));
  }

  async onContentModerated(
    s: ReputationStore,
    p: z.output<(typeof ModerationEvents)['ContentModerated']['schema']>,
    e: EventEnvelope,
  ): Promise<void> {
    if (p.targetType !== 'REVIEW') return;
    const status: ReviewStatus = p.action === 'HIDE' ? 'HIDDEN' : 'VISIBLE';
    const review = await s.setReviewStatus(p.targetId, status);
    if (!review) return; // not ours / unknown: nothing to apply
    const ctx = eventContext(e);
    await this.recompute(s, [review.subjectId], ctx);
    await s.audit(ctx, {
      action: p.action === 'HIDE' ? 'review.hide' : 'review.restore',
      actorId: p.moderatorId,
      actorType: 'ADMIN',
      targetType: 'REVIEW',
      targetId: review.id,
      metadata: { caseId: p.caseId },
    });
  }

  /**
   * Recomputes stats and signals for the given accounts from raw facts (idempotent and
   * independent of event order) and announces them with ReputationUpdated.
   */
  private async recompute(s: ReputationStore, accountIds: string[], ctx: Ctx): Promise<void> {
    const ids = [...new Set(accountIds)].sort();
    await s.lockAccounts(ids);
    for (const accountId of ids) {
      const stats = await s.computeStats(accountId);
      const ratings = await s.ratingInputs(accountId, this.policy.reviewPairCap);
      const signals = computeSignals(stats, ratings, this.policy.reviewPairCap);
      await s.saveStats(stats);
      await s.saveSignals(accountId, signals);
      await s.outbox(
        this.event(
          ReputationEvents.ReputationUpdated,
          accountId,
          {
            accountId,
            ratingAverage: signals.ratingAverage,
            ratingCount: signals.ratingCount,
            completedCount: signals.completedCount,
            cancelledCount: signals.cancelledCount,
            disputedCount: signals.disputedCount,
          },
          ctx,
        ),
      );
    }
  }
}
