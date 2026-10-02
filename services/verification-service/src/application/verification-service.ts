import { VerificationEvents, type EventEnvelope } from '@dorkar/contracts';
import {
  AppError,
  Errors,
  uuidv7,
  type Cursor,
  type RateLimiter,
  type RequestContext,
  type ServiceRuntime,
} from '@dorkar/kernel';
import { evaluate, type Evaluation, type EvaluationContext } from '../domain/policy';
import {
  assertCanSubmitNid,
  assertTransition,
  nidAlreadyUsed,
  validateNidSubmission,
  type NidSubmission,
  type Verification,
  type VerificationKind,
  type VerificationStatus,
} from '../domain/verification';
import type {
  Clock,
  Fingerprinter,
  NidProvider,
  Page,
  VerificationStore,
  VerificationUnitOfWork,
  VerificationWrite,
} from './ports';

const requireActor = (ctx: RequestContext) => {
  if (!ctx.actor) throw Errors.unauthenticated();
  return ctx.actor;
};

/** Thrown by stores when a unique constraint rejects a write (concurrent duplicate). */
export class UniqueViolation extends Error {
  constructor(readonly constraint: string) {
    super(`unique violation: ${constraint}`);
  }
}

export const NID_SUBMIT_LIMIT = { limit: 5, windowMs: 24 * 60 * 60_000 };
export const REJECTED_FINGERPRINT_RETENTION_DAYS = 30;

type Ctx = Pick<RequestContext, 'requestId' | 'correlationId'>;

/** Verification use cases. Each status change writes state, history and its event in one transaction. */
export class VerificationService {
  constructor(
    private readonly uow: VerificationUnitOfWork,
    private readonly event: ServiceRuntime<never>['event'],
    private readonly deps: {
      nidProvider: NidProvider;
      fingerprint: Fingerprinter;
      limiter: RateLimiter;
      clock: Clock;
    },
  ) {}

  async mine(ctx: RequestContext): Promise<Verification[]> {
    return this.uow.store.mine(requireActor(ctx).id);
  }

  async submitNid(
    input: NidSubmission,
    ctx: RequestContext,
  ): Promise<{ kind: 'NID'; status: VerificationStatus }> {
    const actor = requireActor(ctx);
    const rl = await this.deps.limiter.consume([
      { key: `nid-submit:${actor.id}`, ...NID_SUBMIT_LIMIT },
    ]);
    if (!rl.allowed) throw Errors.rateLimited(rl.retryAfterMs);

    const valid = validateNidSubmission(input, this.deps.clock.now());
    const fingerprint = this.deps.fingerprint(valid.nid);

    // Cheap pre-checks before calling the provider; repeated under a row lock below.
    const before = await this.uow.store.current(actor.id, 'NID');
    assertCanSubmitNid(before?.status ?? null);
    if (await this.uow.store.nidVerifiedElsewhere(fingerprint, actor.id)) throw nidAlreadyUsed();

    const result = await this.deps.nidProvider.check({
      accountId: actor.id,
      nid: valid.nid,
      dateOfBirth: valid.dateOfBirth,
      fullName: valid.fullName,
    });
    const provider = this.deps.nidProvider.name;

    try {
      return await this.uow.transaction(async (s) => {
        const current = await s.current(actor.id, 'NID', true);
        assertCanSubmitNid(current?.status ?? null);
        const write: VerificationWrite = {
          status: 'PENDING',
          provider,
          providerRef: result.providerRef,
          nidLast4: valid.last4,
          nidFingerprint: fingerprint,
          reviewedBy: null,
          reviewNote: null,
          verified: false,
          submitted: true,
        };
        let v = current
          ? await this.move(s, current, write, actor.id, 'submitted', ctx)
          : await this.create(s, actor.id, 'NID', write, actor.id, 'submitted', ctx);

        if (result.outcome !== 'PENDING') {
          if (
            result.outcome === 'VERIFIED' &&
            (await s.nidVerifiedElsewhere(fingerprint, actor.id))
          ) {
            throw nidAlreadyUsed();
          }
          v = await this.move(
            s,
            v,
            {
              status: result.outcome,
              provider,
              providerRef: result.providerRef,
              verified: result.outcome === 'VERIFIED',
              submitted: false,
            },
            null,
            `provider ${provider}`,
            ctx,
          );
        }
        await s.audit(ctx, {
          action: 'verification.nid.submitted',
          targetType: 'verification',
          targetId: v.id,
          metadata: { kind: 'NID', status: v.status, provider },
        });
        return { kind: 'NID' as const, status: v.status };
      });
    } catch (err) {
      throw this.mapUnique(err);
    }
  }

  listForReview(
    filter: { status: VerificationStatus; kind?: VerificationKind | undefined },
    after: Cursor | null,
    limit: number,
  ): Promise<Page<Verification>> {
    return this.uow.store.list(filter, after, limit);
  }

  async decide(
    id: string,
    decision: 'VERIFIED' | 'REJECTED',
    note: string,
    ctx: RequestContext,
  ): Promise<Verification> {
    const actor = requireActor(ctx);
    try {
      return await this.uow.transaction(async (s) => {
        const v = await s.byId(id);
        if (!v) throw Errors.notFound('Verification');
        if (v.accountId === actor.id) {
          throw Errors.forbidden('You cannot review your own verification.');
        }
        assertTransition(v.status, decision);
        if (decision === 'VERIFIED' && v.kind === 'NID') {
          const fp = await s.fingerprintOf(v.id);
          if (fp && (await s.nidVerifiedElsewhere(fp, v.accountId))) throw nidAlreadyUsed();
        }
        const next = await this.move(
          s,
          v,
          {
            status: decision,
            provider: v.provider,
            providerRef: v.providerRef,
            reviewedBy: actor.id,
            reviewNote: note,
            verified: decision === 'VERIFIED',
            submitted: false,
          },
          actor.id,
          note,
          ctx,
        );
        await s.audit(ctx, {
          action: 'verification.decided',
          actorType: 'ADMIN',
          targetType: 'verification',
          targetId: v.id,
          metadata: { kind: v.kind, accountId: v.accountId, from: v.status, to: decision },
        });
        return next;
      });
    } catch (err) {
      throw this.mapUnique(err);
    }
  }

  /** Answer for other services before they publish or transact. Two queries, no writes. */
  async evaluate(accountId: string, context: EvaluationContext): Promise<Evaluation> {
    const [policies, verified] = await Promise.all([
      this.uow.store.activePoliciesFor(context.action),
      this.uow.store.verifiedKinds(accountId),
    ]);
    return evaluate(policies, context, verified);
  }

  // ---- event handlers and jobs (called inside the inbox / job transaction) ----

  /** The phone was proven by OTP at sign-up. */
  async onAccountCreated(s: VerificationStore, accountId: string, e: EventEnvelope): Promise<void> {
    if (await s.current(accountId, 'PHONE', true)) return;
    const ctx: Ctx = { requestId: e.id, correlationId: e.correlationId ?? e.id };
    await this.create(
      s,
      accountId,
      'PHONE',
      { status: 'VERIFIED', provider: 'otp', providerRef: null, verified: true, submitted: true },
      null,
      'phone proven by OTP at sign-up',
      ctx,
    );
  }

  purgeRejectedFingerprints(s: VerificationStore): Promise<number> {
    return s.purgeRejectedFingerprints(REJECTED_FINGERPRINT_RETENTION_DAYS);
  }

  // ---- helpers ----

  private async create(
    s: VerificationStore,
    accountId: string,
    kind: VerificationKind,
    w: VerificationWrite,
    actorId: string | null,
    reason: string,
    ctx: Ctx,
  ): Promise<Verification> {
    const v = await s.insert(uuidv7(), accountId, kind, w);
    await s.history(v.id, null, v.status, actorId, reason);
    await s.outbox(this.statusChanged(v, ctx));
    return v;
  }

  private async move(
    s: VerificationStore,
    from: Verification,
    w: VerificationWrite,
    actorId: string | null,
    reason: string,
    ctx: Ctx,
  ): Promise<Verification> {
    assertTransition(from.status, w.status);
    const v = await s.transition(from, w);
    if (!v) {
      throw new AppError('INVALID_STATE_TRANSITION', 'This verification changed meanwhile.', {
        from: from.status,
        to: w.status,
      });
    }
    await s.history(v.id, from.status, v.status, actorId, reason);
    await s.outbox(this.statusChanged(v, ctx));
    return v;
  }

  private statusChanged(v: Verification, ctx: Ctx) {
    return this.event(
      VerificationEvents.VerificationStatusChanged,
      v.accountId,
      { accountId: v.accountId, kind: v.kind, status: v.status },
      ctx,
    );
  }

  private mapUnique(err: unknown): unknown {
    if (!(err instanceof UniqueViolation)) return err;
    if (err.constraint === 'verifications_nid_verified_once') return nidAlreadyUsed();
    // A concurrent submission created the record first.
    return new AppError('BUSINESS_RULE_VIOLATION', 'Your NID is already being reviewed.', {
      rule: 'NID_PENDING',
    });
  }
}
