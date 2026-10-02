import type { TransactionEvents } from '@dorkar/contracts';
import { LendingEvents, type EventEnvelope, type LoanStatus } from '@dorkar/contracts';
import {
  AppError,
  Errors,
  uuidv7,
  type Actor,
  type AuditEntry,
  type Logger,
  type RequestContext,
  type ServiceRuntime,
} from '@dorkar/kernel';
import type { z } from 'zod';
import { assertNoContactInfo } from '../domain/lend-item';
import {
  assertCanRequest,
  assertEligible,
  assertLoanWindow,
  availableCommands,
  BLOCKING_STATUSES,
  decide,
  mirrorTarget,
  type ActorRole,
  type Loan,
  type LoanCommand,
  type LoanTransition,
  type TransitionFacts,
} from '../domain/loan';
import { derivedContext, requireActor } from './context';
import type { LendingStore, LendingUnitOfWork, LoanListQuery, VerificationGateway } from './ports';

/** Commands a party runs over HTTP. */
export const PartyCommands = [
  'approve',
  'decline',
  'cancel',
] as const satisfies readonly LoanCommand[];
export type PartyCommand = (typeof PartyCommands)[number];

export interface RequestInput {
  itemId: string;
  startAt: Date;
  returnBy: Date;
  message?: string | undefined;
}

export interface LoanDetail {
  loan: Loan;
  transitions: LoanTransition[];
  viewerRole: 'LENDER' | 'BORROWER' | null;
  actions: PartyCommand[];
}

const partyRole = (loan: Loan, accountId: string): 'LENDER' | 'BORROWER' | null =>
  loan.lenderId === accountId ? 'LENDER' : loan.borrowerId === accountId ? 'BORROWER' : null;

const actorTypeOf = (role: ActorRole): NonNullable<AuditEntry['actorType']> =>
  role === 'SYSTEM' ? 'SYSTEM' : 'USER';

const facts = (loan: Loan) => ({
  loanId: loan.id,
  itemId: loan.itemId,
  lenderId: loan.lenderId,
  borrowerId: loan.borrowerId,
});

type TxCreated = z.output<(typeof TransactionEvents)['TransactionCreated']['schema']>;
type TxStateChanged = z.output<(typeof TransactionEvents)['TransactionStateChanged']['schema']>;

const JOB_BATCH = 100;

/**
 * Borrow requests, trust gating and approval. After approval the transaction owns the
 * lifecycle and this service mirrors it (ADR-0008).
 */
export class LoanService {
  constructor(
    private readonly uow: LendingUnitOfWork,
    private readonly event: ServiceRuntime<never>['event'],
    private readonly verification: VerificationGateway,
    private readonly policy: { requestTtlMs: number },
    private readonly logger: Logger,
  ) {}

  // ---- request

  async request(input: RequestInput, ctx: RequestContext): Promise<LoanDetail> {
    const actor = requireActor(ctx);
    assertNoContactInfo('message', input.message);
    const s0 = this.uow.store;
    const item = await s0.item(input.itemId);
    if (!item || item.hidden) throw Errors.notFound('Item');
    assertCanRequest(item, actor.id);
    assertLoanWindow(input, item.maxLoanDays, await s0.now());
    assertEligible(item.requirements, await s0.borrowerFacts(actor.id));

    const decision = await this.verification.evaluate(
      {
        accountId: actor.id,
        action: 'LOAN_REQUEST',
        categoryId: item.categoryId,
        mode: 'BORROW',
        amount: item.depositAmount ?? 0,
      },
      ctx,
    );
    if (!decision.satisfied) {
      throw new AppError('VERIFICATION_REQUIRED', 'Verify your account to borrow items.', {
        action: 'LOAN_REQUEST',
        missing: decision.missing,
      });
    }

    return this.uow.transaction(async (s) => {
      // Re-check under lock: the item may have changed while verification answered.
      const locked = await s.item(input.itemId, { forUpdate: true });
      if (!locked || locked.hidden) throw Errors.notFound('Item');
      assertCanRequest(locked, actor.id);
      assertLoanWindow(input, locked.maxLoanDays, await s.now());
      assertEligible(locked.requirements, await s.borrowerFacts(actor.id));

      const loan = await s.insertLoan({
        id: uuidv7(),
        itemId: locked.id,
        lenderId: locked.lenderId,
        borrowerId: actor.id,
        itemTitle: locked.title,
        categoryId: locked.categoryId,
        startAt: input.startAt,
        returnBy: input.returnBy,
        message: input.message ?? null,
        depositAmount: locked.depositAmount,
      });
      await s.appendTransition({
        loanId: loan.id,
        from: null,
        to: 'REQUESTED',
        command: 'request',
        actorId: actor.id,
        actorRole: 'BORROWER',
        reason: null,
      });
      await s.audit(ctx, {
        action: 'lending.loan.requested',
        targetType: 'loan',
        targetId: loan.id,
        metadata: { itemId: loan.itemId },
      });
      await s.outbox(
        this.event(
          LendingEvents.LoanRequested,
          loan.id,
          {
            ...facts(loan),
            startAt: loan.startAt.toISOString(),
            returnBy: loan.returnBy.toISOString(),
          },
          ctx,
        ),
      );
      return this.compose(s, loan, await s.now(), actor);
    });
  }

  // ---- party commands

  async command(
    id: string,
    command: PartyCommand,
    input: { reason?: string | undefined },
    ctx: RequestContext,
  ): Promise<LoanDetail> {
    const actor = requireActor(ctx);
    assertNoContactInfo('reason', input.reason);
    return this.uow.transaction(async (s) => {
      const loaded = await s.loan(id, { forUpdate: true });
      const role = loaded ? partyRole(loaded.value, actor.id) : null;
      if (!loaded || !role) throw Errors.notFound('Loan');
      const loan = await this.apply(
        s,
        loaded.value,
        loaded.now,
        command,
        role,
        actor.id,
        input,
        ctx,
      );
      return this.compose(s, loan!, loaded.now, actor);
    });
  }

  // ---- reads

  async get(id: string, ctx: RequestContext): Promise<LoanDetail> {
    const actor = requireActor(ctx);
    const loaded = await this.uow.store.loan(id);
    if (!loaded) throw Errors.notFound('Loan');
    if (!partyRole(loaded.value, actor.id) && !actor.permissions.has('transaction:read:any')) {
      throw Errors.notFound('Loan');
    }
    return this.compose(this.uow.store, loaded.value, loaded.now, actor);
  }

  listMine(
    role: 'lender' | 'borrower' | undefined,
    q: LoanListQuery,
    ctx: RequestContext,
  ): Promise<Loan[]> {
    return this.uow.store.loansForParty(requireActor(ctx).id, role, q);
  }

  listAll(q: LoanListQuery): Promise<Loan[]> {
    return this.uow.store.allLoans(q);
  }

  // ---- transaction mirror (inside the inbox transaction)

  async onTransactionCreated(s: LendingStore, p: TxCreated): Promise<void> {
    if (p.sourceType !== 'LOAN') return;
    await s.setTransactionId(p.sourceId, p.transactionId);
  }

  async onTransactionStateChanged(
    s: LendingStore,
    p: TxStateChanged,
    e: EventEnvelope,
  ): Promise<void> {
    if (p.sourceType !== 'LOAN') return;
    const loaded = await s.loan(p.sourceId, { forUpdate: true });
    if (!loaded) return;
    let loan = loaded.value;
    if (!loan.transactionId) loan = (await s.setTransactionId(loan.id, p.transactionId)) ?? loan;
    const to = mirrorTarget(loan.status, p.to);
    if (!to) return;
    const ctx = derivedContext(e.id, e.correlationId);

    // Re-entering a blocking status (dispute withdrawn) must not double-book the item. The
    // transaction stays authoritative; lending keeps its last state and says so loudly.
    const blocking = (st: LoanStatus) => (BLOCKING_STATUSES as readonly string[]).includes(st);
    if (blocking(to) && !blocking(loan.status) && (await s.hasBlockingOverlap(loan))) {
      this.logger.warn(
        { loanId: loan.id, from: loan.status, to, transactionId: p.transactionId },
        'loan mirror skipped: the period now overlaps another active loan',
      );
      return;
    }

    const command = `transaction:${p.to}`;
    const updated = await s.transitionLoan(
      loan.id,
      { from: loan.status, version: loan.version },
      to,
      {},
    );
    if (!updated) throw Errors.conflict('Loan changed concurrently; retry.');
    await this.recordChange(s, loan, updated, command, 'SYSTEM', null, ctx);
  }

  // ---- jobs (inside the job's transaction; due rows are locked)

  async expireDue(s: LendingStore): Promise<number> {
    const ids = await s.dueForExpiry(this.policy.requestTtlMs, JOB_BATCH);
    let n = 0;
    for (const id of ids) {
      const loaded = await s.loan(id);
      if (!loaded) continue;
      try {
        const done = await this.apply(
          s,
          loaded.value,
          loaded.now,
          'expire',
          'SYSTEM',
          null,
          {},
          derivedContext(`lending.expire-requests:${id}`),
          { lenient: true },
        );
        if (done) n++;
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
      }
    }
    return n;
  }

  /** LoanOverdue is emitted once per loan (guarded stamp). Not a status change. */
  async notifyOverdue(s: LendingStore): Promise<number> {
    const ids = await s.dueForOverdue(JOB_BATCH);
    let n = 0;
    for (const id of ids) {
      if (!(await s.markOverdueNotified(id))) continue;
      const loan = (await s.loan(id))!.value;
      const ctx = derivedContext(`lending.overdue-loans:${id}`);
      await s.audit(ctx, {
        action: 'lending.loan.overdue',
        actorId: null,
        actorType: 'SYSTEM',
        targetType: 'loan',
        targetId: loan.id,
        metadata: { status: loan.status },
      });
      await s.outbox(
        this.event(
          LendingEvents.LoanOverdue,
          loan.id,
          {
            ...facts(loan),
            transactionId: loan.transactionId,
            returnBy: loan.returnBy.toISOString(),
          },
          ctx,
        ),
      );
      n++;
    }
    return n;
  }

  // ---- the one place lending decides a status change

  private async apply(
    s: LendingStore,
    loan: Loan,
    now: Date,
    command: LoanCommand,
    role: ActorRole,
    actorId: string | null,
    input: { reason?: string | undefined },
    ctx: RequestContext,
    opts: { lenient?: boolean } = {},
  ): Promise<Loan | null> {
    let itemAvailable = true;
    if (command === 'approve') {
      const item = await s.item(loan.itemId);
      itemAvailable = !!item && item.active && !item.hidden;
    }
    const d = decide(this.facts(loan, now, itemAvailable), command, role);
    const updated = await s.transitionLoan(
      loan.id,
      { from: d.from, version: loan.version },
      d.to,
      command === 'decline' && input.reason ? { declineReason: input.reason } : {},
    );
    if (!updated) {
      if (opts.lenient) return null;
      throw Errors.conflict('This loan was just changed. Reload and try again.', {
        rule: 'CONCURRENT_UPDATE',
      });
    }
    await this.recordChange(s, loan, updated, command, role, actorId, ctx, input.reason ?? null);
    if (d.to === 'APPROVED') {
      await s.outbox(
        this.event(
          LendingEvents.LoanApproved,
          loan.id,
          {
            ...facts(updated),
            startAt: updated.startAt.toISOString(),
            returnBy: updated.returnBy.toISOString(),
            deposit:
              updated.depositAmount === null
                ? null
                : { amount: updated.depositAmount, currency: 'BDT' },
            terms: {
              itemTitle: updated.itemTitle,
              categoryId: updated.categoryId,
            },
          },
          ctx,
        ),
      );
    }
    return updated;
  }

  /** History row, audit and LoanStatusChanged for every status change. */
  private async recordChange(
    s: LendingStore,
    before: Loan,
    after: Loan,
    command: string,
    role: ActorRole,
    actorId: string | null,
    ctx: RequestContext,
    reason: string | null = null,
  ): Promise<void> {
    await s.appendTransition({
      loanId: after.id,
      from: before.status,
      to: after.status,
      command,
      actorId,
      actorRole: role,
      reason,
    });
    await s.audit(ctx, {
      action: `lending.loan.${command.startsWith('transaction:') ? 'mirrored' : command}`,
      actorId,
      actorType: actorTypeOf(role),
      targetType: 'loan',
      targetId: after.id,
      metadata: { from: before.status, to: after.status, role },
    });
    await s.outbox(
      this.event(
        LendingEvents.LoanStatusChanged,
        after.id,
        {
          ...facts(after),
          from: before.status,
          to: after.status,
          transactionId: after.transactionId,
          // A code, never free text: events carry no user-written content.
          reason: command,
        },
        ctx,
      ),
    );
  }

  private facts(loan: Loan, now: Date, itemAvailable = true): TransitionFacts {
    return { status: loan.status, returnBy: loan.returnBy, now, itemAvailable };
  }

  private async compose(
    s: LendingStore,
    loan: Loan,
    now: Date,
    viewer: Actor,
  ): Promise<LoanDetail> {
    const viewerRole = partyRole(loan, viewer.id);
    let actions: PartyCommand[] = [];
    if (viewerRole) {
      let itemAvailable = true;
      if (viewerRole === 'LENDER' && loan.status === 'REQUESTED') {
        const item = await s.item(loan.itemId);
        itemAvailable = !!item && item.active && !item.hidden;
      }
      const allowed = new Set<LoanCommand>(
        availableCommands(this.facts(loan, now, itemAvailable), viewerRole),
      );
      actions = PartyCommands.filter((c) => allowed.has(c));
    }
    return { loan, transitions: await s.transitions(loan.id), viewerRole, actions };
  }
}
