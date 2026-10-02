import {
  DisputeEvents,
  type DisputeResolution,
  type EventEnvelope,
  type NeedMode,
  type TransactionSourceType,
  type TransactionState,
  type DisputeReason,
} from '@dorkar/contracts';
import {
  AppError,
  Errors,
  uuidv7,
  type Actor,
  type AuditEntry,
  type RequestContext,
  type ServiceRuntime,
} from '@dorkar/kernel';
import {
  assertEvidenceNotEmpty,
  assertNoContactInfo,
  assertNotOwnDispute,
  assertResolutionSupported,
  available,
  decide,
  dedupe,
  isLive,
  openerOf,
  partyRole,
  type AuthorRole,
  type CaseActor,
  type CaseFacts,
  type Dispute,
  type DisputeCommand,
  type Entry,
  type PartyRole,
  type TargetParty,
} from '../domain/dispute';
import type {
  AdminListQuery,
  DisputeStore,
  DisputeUnitOfWork,
  Loaded,
  PartyListQuery,
  TransitionPatch,
} from './ports';

/** What a viewer may do next, as exposed to clients. */
export const ActionNames = [
  'statement',
  'evidence',
  'withdraw',
  'assign',
  'note',
  'request-info',
  'resolve',
] as const;
export type ActionName = (typeof ActionNames)[number];

export type ViewerRole = PartyRole | 'STAFF';

export interface DisputeDetail {
  dispute: Dispute;
  viewerRole: ViewerRole;
  entries: Entry[];
  actions: ActionName[];
}

export interface DisputeSettings {
  responseHours: number;
  unassignedEscalationHours: number;
}

export interface DealCreatedFacts {
  transactionId: string;
  buyerId: string;
  sellerId: string;
  mode: NeedMode;
  amount: { amount: number; currency: string };
  sourceType: TransactionSourceType;
  sourceId: string;
}

export interface DealStateChangedFacts {
  transactionId: string;
  buyerId: string;
  sellerId: string;
  sourceType: TransactionSourceType;
  sourceId: string;
  from: TransactionState;
  to: TransactionState;
  actorId: string | null;
  mode?: NeedMode | undefined;
  reason?: string | null | undefined;
  disputeReason?: DisputeReason | undefined;
}

const requireActor = (ctx: RequestContext): Actor => {
  if (!ctx.actor) throw Errors.unauthenticated();
  return ctx.actor;
};

/** Context for work that is not an HTTP request (event consumers, jobs). */
export const derivedContext = (requestId: string, correlationId?: string): RequestContext => ({
  requestId,
  correlationId: correlationId ?? requestId,
  ipHash: null,
  userAgent: null,
  actor: null,
});

const AUDIT_TARGET = 'dispute';
const JOB_BATCH = 100;

const facts = (d: Dispute): CaseFacts => ({
  status: d.status,
  statementSubmitted: d.statementSubmittedAt !== null,
});

const caseActorOf = (d: Dispute, accountId: string): CaseActor | null =>
  d.openedBy === accountId ? 'OPENER' : d.respondentId === accountId ? 'RESPONDENT' : null;

const auditActorType = (role: AuthorRole): NonNullable<AuditEntry['actorType']> =>
  role === 'SYSTEM' ? 'SYSTEM' : role === 'STAFF' ? 'ADMIN' : 'USER';

const notLive = (d: Dispute) =>
  new AppError('INVALID_STATE_TRANSITION', `The dispute is ${d.status.toLowerCase()}.`, {
    rule: 'CASE_CLOSED',
    status: d.status,
  });

const lostRace = () =>
  new AppError(
    'INVALID_STATE_TRANSITION',
    'This dispute was just changed by someone else. Reload and try again.',
    { rule: 'CONCURRENT_UPDATE' },
  );

/**
 * Dispute cases: opened from the transaction's DISPUTED transition, worked by the parties and
 * staff, decided here and applied by transaction-service from DisputeResolved/DisputeWithdrawn.
 * Every change writes its state, its timeline entry, an audit record and its events in one
 * DB transaction.
 */
export class DisputeService {
  constructor(
    private readonly uow: DisputeUnitOfWork,
    private readonly event: ServiceRuntime<never>['event'],
    private readonly settings: DisputeSettings,
  ) {}

  // ---------------------------------------------------------------- event handlers (inbox trx)

  async onTransactionCreated(s: DisputeStore, p: DealCreatedFacts): Promise<void> {
    const deal = {
      transactionId: p.transactionId,
      buyerId: p.buyerId,
      sellerId: p.sellerId,
      mode: p.mode,
      amount: p.amount.amount,
      currency: p.amount.currency,
      sourceType: p.sourceType,
      sourceId: p.sourceId,
    };
    await s.upsertDeal(deal);
    await s.fillDealFacts(deal);
  }

  async onTransactionStateChanged(
    s: DisputeStore,
    p: DealStateChangedFacts,
    e: EventEnvelope,
  ): Promise<void> {
    const ctx = derivedContext(e.id, e.correlationId);
    if (p.to === 'DISPUTED') await this.open(s, p, ctx);
    else if (p.from === 'DISPUTED') await this.settle(s, p, ctx);
  }

  private async open(s: DisputeStore, p: DealStateChangedFacts, ctx: RequestContext) {
    // StateChanged may arrive before TransactionCreated: the payload carries the parties.
    await s.upsertDeal({
      transactionId: p.transactionId,
      buyerId: p.buyerId,
      sellerId: p.sellerId,
      mode: p.mode ?? null,
      amount: null,
      currency: null,
      sourceType: p.sourceType,
      sourceId: p.sourceId,
    });
    const deal = await s.deal(p.transactionId);
    const openedBy = openerOf(p.buyerId, p.sellerId, p.actorId);
    const respondentId = openedBy === p.buyerId ? p.sellerId : p.buyerId;
    const d = await s.insert({
      id: uuidv7(),
      transactionId: p.transactionId,
      buyerId: p.buyerId,
      sellerId: p.sellerId,
      openedBy,
      respondentId,
      previousState: p.from,
      reason: p.disputeReason ?? 'OTHER',
      description: p.reason ?? null,
      mode: p.mode ?? deal?.mode ?? null,
      amount: deal?.amount ?? null,
      currency: deal?.currency ?? null,
      respondWithinHours: this.settings.responseHours,
    });
    if (!d) return; // a live case already exists for this transaction

    await s.appendEntry({
      disputeId: d.id,
      kind: 'OPENED',
      authorId: openedBy,
      authorRole: partyRole(d, openedBy)!,
      visibility: 'PARTIES',
      text: d.description,
    });
    await s.audit(ctx, {
      action: 'dispute.opened',
      actorId: openedBy,
      actorType: 'USER',
      targetType: AUDIT_TARGET,
      targetId: d.id,
      metadata: {
        transactionId: d.transactionId,
        reason: d.reason,
        previousState: d.previousState,
      },
    });
    await s.outbox(
      this.event(
        DisputeEvents.DisputeOpened,
        d.id,
        {
          disputeId: d.id,
          transactionId: d.transactionId,
          buyerId: d.buyerId,
          sellerId: d.sellerId,
          openedBy,
          reason: d.reason,
          previousState: d.previousState,
        },
        ctx,
      ),
    );
  }

  /** The transaction left DISPUTED: record how, and close a case nobody decided. */
  private async settle(s: DisputeStore, p: DealStateChangedFacts, ctx: RequestContext) {
    const d = await s.unappliedForTransaction(p.transactionId);
    if (!d) return;
    if (isLive(d.status)) {
      await this.change(
        s,
        d,
        'close-without-decision',
        'SYSTEM',
        null,
        { withdrawnBy: null, applied: { finalState: p.to } },
        ctx,
        `The deal left the dispute (now ${p.to}) without a decision here, so the case was closed.`,
      );
      return;
    }
    await s.markApplied(d.id, p.to);
    await s.audit(ctx, {
      action: 'dispute.applied',
      actorId: null,
      actorType: 'SYSTEM',
      targetType: AUDIT_TARGET,
      targetId: d.id,
      metadata: { status: d.status, finalTransactionState: p.to },
    });
  }

  // ---------------------------------------------------------------- reads

  async get(id: string, ctx: RequestContext): Promise<DisputeDetail> {
    const actor = requireActor(ctx);
    const loaded = await this.uow.store.load(id);
    const role = loaded ? this.viewerRole(loaded.dispute, actor) : null;
    if (!loaded || !role) throw Errors.notFound('Dispute');
    return this.compose(this.uow.store, loaded.dispute, actor);
  }

  listMine(q: PartyListQuery, ctx: RequestContext): Promise<Dispute[]> {
    const actor = requireActor(ctx);
    return this.uow.store.listForParty(actor.id, q);
  }

  listAdmin(q: AdminListQuery, ctx: RequestContext): Promise<Dispute[]> {
    const actor = requireActor(ctx);
    return this.uow.store.listAdmin({
      ...q,
      assignee: q.assignee === 'me' ? actor.id : q.assignee,
    });
  }

  // ---------------------------------------------------------------- party commands

  async submitStatement(id: string, text: string, ctx: RequestContext): Promise<DisputeDetail> {
    const actor = requireActor(ctx);
    assertNoContactInfo('statement', text);
    return this.uow.transaction(async (s) => {
      const d = await this.loadVisible(s, id, actor);
      const role = this.authorRole(d, actor);
      const caseActor = caseActorOf(d, actor.id) ?? 'STAFF';
      decide(facts(d), 'submit-statement', caseActor); // validate before writing anything
      const entry = await s.appendEntry({
        disputeId: d.id,
        kind: 'STATEMENT',
        authorId: actor.id,
        authorRole: role,
        visibility: 'PARTIES',
        text,
      });
      const next = await this.mustChange(
        s,
        d,
        'submit-statement',
        caseActor,
        actor.id,
        { statementSubmitted: true },
        ctx,
        null,
        { entryId: entry.id, late: d.respondentMissedDeadline },
      );
      return this.compose(s, next, actor);
    });
  }

  async addEvidence(
    id: string,
    input: { text?: string | undefined; mediaIds?: string[] | undefined },
    ctx: RequestContext,
  ): Promise<DisputeDetail> {
    const actor = requireActor(ctx);
    const text = input.text ?? null;
    const mediaIds = dedupe(input.mediaIds ?? []);
    assertEvidenceNotEmpty(text, mediaIds);
    assertNoContactInfo('evidence', text);
    return this.uow.transaction(async (s) => {
      const d = await this.loadVisible(s, id, actor);
      const role = this.authorRole(d, actor);
      if (!isLive(d.status)) throw notLive(d);
      const entry = await s.appendEntry({
        disputeId: d.id,
        kind: 'EVIDENCE',
        authorId: actor.id,
        authorRole: role,
        visibility: 'PARTIES',
        text,
        mediaIds,
      });
      await s.audit(ctx, {
        action: 'dispute.evidence.added',
        actorType: auditActorType(role),
        targetType: AUDIT_TARGET,
        targetId: d.id,
        metadata: { entryId: entry.id, role, mediaCount: mediaIds.length },
      });
      return this.compose(s, d, actor);
    });
  }

  async withdraw(id: string, ctx: RequestContext): Promise<DisputeDetail> {
    const actor = requireActor(ctx);
    return this.uow.transaction(async (s) => {
      const d = await this.loadVisible(s, id, actor);
      const caseActor = caseActorOf(d, actor.id) ?? 'STAFF';
      const next = await this.mustChange(
        s,
        d,
        'withdraw',
        caseActor,
        actor.id,
        { withdrawnBy: actor.id },
        ctx,
        null,
      );
      await s.outbox(
        this.event(
          DisputeEvents.DisputeWithdrawn,
          d.id,
          {
            disputeId: d.id,
            transactionId: d.transactionId,
            buyerId: d.buyerId,
            sellerId: d.sellerId,
            withdrawnBy: actor.id,
            previousState: d.previousState,
          },
          ctx,
        ),
      );
      return this.compose(s, next, actor);
    });
  }

  // ---------------------------------------------------------------- staff commands

  async assign(id: string, assignee: string, ctx: RequestContext): Promise<DisputeDetail> {
    const actor = requireActor(ctx);
    const assigneeId = assignee === 'me' ? actor.id : assignee;
    return this.uow.transaction(async (s) => {
      const d = await this.loadForStaff(s, id, actor);
      if (partyRole(d, assigneeId)) {
        throw new AppError(
          'BUSINESS_RULE_VIOLATION',
          'A dispute cannot be assigned to one of its parties.',
          { rule: 'ASSIGNEE_IS_PARTY' },
        );
      }
      if (!isLive(d.status)) throw notLive(d);
      const next = await s.assign(d.id, assigneeId);
      if (!next) throw notLive(d);
      await s.appendEntry({
        disputeId: d.id,
        kind: 'ASSIGNMENT',
        authorId: actor.id,
        authorRole: 'STAFF',
        visibility: 'STAFF',
        text: `Assigned to ${assigneeId}`,
      });
      await s.audit(ctx, {
        action: 'dispute.assigned',
        actorType: 'ADMIN',
        targetType: AUDIT_TARGET,
        targetId: d.id,
        metadata: { assigneeId, previousAssignee: d.assignedTo },
      });
      return this.compose(s, next, actor);
    });
  }

  async addNote(id: string, text: string, ctx: RequestContext): Promise<DisputeDetail> {
    const actor = requireActor(ctx);
    return this.uow.transaction(async (s) => {
      const d = await this.loadForStaff(s, id, actor);
      const entry = await s.appendEntry({
        disputeId: d.id,
        kind: 'NOTE',
        authorId: actor.id,
        authorRole: 'STAFF',
        visibility: 'STAFF',
        text,
      });
      await s.audit(ctx, {
        action: 'dispute.note.added',
        actorType: 'ADMIN',
        targetType: AUDIT_TARGET,
        targetId: d.id,
        metadata: { entryId: entry.id },
      });
      return this.compose(s, d, actor);
    });
  }

  async requestInfo(
    id: string,
    input: { party: TargetParty; message: string },
    ctx: RequestContext,
  ): Promise<DisputeDetail> {
    const actor = requireActor(ctx);
    return this.uow.transaction(async (s) => {
      const d = await this.loadForStaff(s, id, actor);
      if (!isLive(d.status)) throw notLive(d);
      const entry = await s.appendEntry({
        disputeId: d.id,
        kind: 'INFO_REQUEST',
        authorId: actor.id,
        authorRole: 'STAFF',
        visibility: 'PARTIES',
        text: input.message,
        targetParty: input.party,
      });
      await s.audit(ctx, {
        action: 'dispute.info.requested',
        actorType: 'ADMIN',
        targetType: AUDIT_TARGET,
        targetId: d.id,
        metadata: { entryId: entry.id, party: input.party },
      });
      return this.compose(s, d, actor);
    });
  }

  async resolve(
    id: string,
    input: { resolution: DisputeResolution; note: string },
    ctx: RequestContext,
  ): Promise<DisputeDetail> {
    const actor = requireActor(ctx);
    return this.uow.transaction(async (s) => {
      const d = await this.loadForStaff(s, id, actor);
      assertResolutionSupported(input.resolution, d.paymentProvider);
      const next = await this.mustChange(
        s,
        d,
        'resolve',
        'STAFF',
        actor.id,
        { resolution: { resolution: input.resolution, note: input.note, by: actor.id } },
        ctx,
        input.note,
        { resolution: input.resolution },
      );
      await s.outbox(
        this.event(
          DisputeEvents.DisputeResolved,
          d.id,
          {
            disputeId: d.id,
            transactionId: d.transactionId,
            buyerId: d.buyerId,
            sellerId: d.sellerId,
            resolution: input.resolution,
            resolvedBy: actor.id,
            note: input.note,
          },
          ctx,
        ),
      );
      return this.compose(s, next, actor);
    });
  }

  // ---------------------------------------------------------------- jobs (job transaction)

  /** Respondents who let respond_by pass: the case moves on to review without them. */
  async deadlineDue(s: DisputeStore): Promise<number> {
    let n = 0;
    for (const id of await s.dueForDeadline(JOB_BATCH)) {
      const loaded = await s.load(id);
      if (!loaded || loaded.dispute.status !== 'AWAITING_RESPONSE') continue;
      const done = await this.change(
        s,
        loaded.dispute,
        'respondent-deadline',
        'SYSTEM',
        null,
        { respondentMissedDeadline: true },
        derivedContext(`dispute.respondent-deadline:${id}`),
        'The other party did not respond in time. The case moved to review.',
        {},
        { lenient: true },
      );
      if (done) n++;
    }
    return n;
  }

  /** Live cases nobody picked up in time get flagged for the staff queue. */
  async escalateDue(s: DisputeStore): Promise<number> {
    const ids = await s.escalateUnassigned(this.settings.unassignedEscalationHours, JOB_BATCH);
    for (const id of ids) {
      await s.appendEntry({
        disputeId: id,
        kind: 'ESCALATION',
        authorId: null,
        authorRole: 'SYSTEM',
        visibility: 'STAFF',
        text: `Unassigned for more than ${this.settings.unassignedEscalationHours} hours.`,
      });
      await s.audit(derivedContext(`dispute.escalate-unassigned:${id}`), {
        action: 'dispute.escalated',
        actorId: null,
        actorType: 'SYSTEM',
        targetType: AUDIT_TARGET,
        targetId: id,
      });
    }
    return ids.length;
  }

  // ---------------------------------------------------------------- the one place status changes

  private async change(
    s: DisputeStore,
    d: Dispute,
    command: DisputeCommand,
    caseActor: CaseActor,
    actorId: string | null,
    patch: TransitionPatch,
    ctx: RequestContext,
    entryText: string | null,
    metadata: Record<string, unknown> = {},
    opts: { lenient?: boolean } = {},
  ): Promise<Dispute | null> {
    const dec = decide(facts(d), command, caseActor);
    const next = await s.transition(d.id, { from: d.status, version: d.version }, dec.to, patch);
    if (!next) {
      if (opts.lenient) return null;
      throw lostRace();
    }
    const role: AuthorRole =
      caseActor === 'SYSTEM'
        ? 'SYSTEM'
        : caseActor === 'STAFF'
          ? 'STAFF'
          : partyRole(d, actorId ?? '')!;
    if (dec.from !== dec.to) {
      await s.appendEntry({
        disputeId: d.id,
        kind: 'STATUS_CHANGE',
        authorId: actorId,
        authorRole: role,
        visibility: 'PARTIES',
        text: entryText,
        fromStatus: dec.from,
        toStatus: dec.to,
      });
    }
    await s.audit(ctx, {
      action: `dispute.${command}`,
      actorId,
      actorType: auditActorType(role),
      targetType: AUDIT_TARGET,
      targetId: d.id,
      metadata: { ...metadata, from: dec.from, to: dec.to },
    });
    if (dec.from !== dec.to) {
      await s.outbox(
        this.event(
          DisputeEvents.DisputeStatusChanged,
          d.id,
          {
            disputeId: d.id,
            transactionId: d.transactionId,
            buyerId: d.buyerId,
            sellerId: d.sellerId,
            from: dec.from,
            to: dec.to,
            actorId,
          },
          ctx,
        ),
      );
    }
    return next;
  }

  /** `change` for request paths: losing a race is a 409, never a silent no-op. */
  private async mustChange(...args: Parameters<DisputeService['change']>): Promise<Dispute> {
    const next = await this.change(...args);
    if (!next) throw lostRace();
    return next;
  }

  // ---------------------------------------------------------------- helpers

  private viewerRole(d: Dispute, actor: Actor): ViewerRole | null {
    return partyRole(d, actor.id) ?? (actor.permissions.has('dispute:read') ? 'STAFF' : null);
  }

  private authorRole(d: Dispute, actor: Actor): PartyRole | 'STAFF' {
    return partyRole(d, actor.id) ?? 'STAFF';
  }

  /** Parties and staff see the case; anyone else gets a 404. */
  private async loadVisible(s: DisputeStore, id: string, actor: Actor): Promise<Dispute> {
    const loaded = await s.load(id);
    if (!loaded || !this.viewerRole(loaded.dispute, actor)) throw Errors.notFound('Dispute');
    return loaded.dispute;
  }

  /** Staff routes are permission-gated already; staff never handle their own dispute. */
  private async loadForStaff(s: DisputeStore, id: string, actor: Actor): Promise<Dispute> {
    const loaded: Loaded | null = await s.load(id);
    if (!loaded) throw Errors.notFound('Dispute');
    assertNotOwnDispute(actor.id, loaded.dispute);
    return loaded.dispute;
  }

  private async compose(s: DisputeStore, d: Dispute, viewer: Actor): Promise<DisputeDetail> {
    const viewerRole = this.viewerRole(d, viewer)!;
    const staff = viewerRole === 'STAFF';
    const entries = await s.entries(d.id, staff);
    const f = facts(d);
    const actions: ActionName[] = [];
    if (!staff) {
      const caseActor = caseActorOf(d, viewer.id)!;
      const can = new Set(available(f, caseActor));
      if (can.has('submit-statement')) actions.push('statement');
      if (isLive(d.status)) actions.push('evidence');
      if (can.has('withdraw')) actions.push('withdraw');
    } else {
      const live = isLive(d.status);
      if (live) actions.push('evidence', 'assign');
      actions.push('note');
      if (viewer.permissions.has('dispute:resolve') && live) {
        actions.push('request-info');
        if (available(f, 'STAFF').includes('resolve')) actions.push('resolve');
      }
    }
    return {
      dispute: d,
      viewerRole,
      // Parties see staff as a role, never who.
      entries: staff
        ? entries
        : entries.map((e) => (e.authorRole === 'STAFF' ? { ...e, authorId: null } : e)),
      actions,
    };
  }
}
