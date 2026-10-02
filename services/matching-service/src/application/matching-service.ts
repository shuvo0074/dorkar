import { MatchingEvents, type EventEnvelope, type NeedStatus } from '@dorkar/contracts';
import {
  decodeCursor,
  Errors,
  uuidv7,
  type Cursor,
  type RequestContext,
  type ServiceRuntime,
} from '@dorkar/kernel';
import {
  candidateListingId,
  delivers,
  districtsNear,
  KindsForMode,
  modesForKind,
  modesForRoles,
  NO_SIGNALS,
  rescoredStatus,
  RETIRABLE,
  RolesForMode,
  selectBestPerSeller,
  transition,
  type Candidate,
  type ScoredCandidate,
  type ScoringNeed,
} from '../domain/matching';
import type { MatchScorer } from '../domain/scoring';
import type {
  ListingFacts,
  MatchedNeed,
  NeedFacts,
  MatchingSettings,
  MatchingStore,
  MatchingUnitOfWork,
  MatchRecord,
  MatchWrite,
  OpenNeedQuery,
  Page,
} from './ports';

/** Upper bound of candidates pulled per need by the SQL prefilter before scoring in memory. */
export const CANDIDATE_SCAN_LIMIT = 1000;

type EventCtx = Pick<RequestContext, 'correlationId' | 'requestId'>;

/** Events we emit while handling an event are caused by it and share its correlation. */
export const causedBy = (e: EventEnvelope): EventCtx => ({
  requestId: e.id,
  correlationId: e.correlationId ?? e.id,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cursorOf(raw: string | undefined, key: 'number' | 'date'): Cursor | null {
  const c = decodeCursor(raw);
  if (!c) return null;
  const okKey =
    key === 'number'
      ? typeof c.k === 'number' && Number.isFinite(c.k)
      : typeof c.k === 'string' && !Number.isNaN(Date.parse(c.k));
  if (!okKey || !UUID.test(c.id)) throw Errors.validation('Invalid cursor.');
  return c;
}

const requireActor = (ctx: RequestContext) => {
  if (!ctx.actor) throw Errors.unauthenticated();
  return ctx.actor;
};

const sameWrite = (m: MatchRecord, w: MatchWrite) =>
  m.listingId === w.listingId &&
  m.score === w.score &&
  m.status === w.status &&
  m.scorer === w.scorer &&
  JSON.stringify(m.reasons) === JSON.stringify(w.reasons);

/**
 * Matching use cases. Event handlers receive the store bound to the inbox transaction, so
 * projections, matches and MatchFound events commit together, exactly once per event.
 */
export class MatchingService {
  constructor(
    private readonly uow: MatchingUnitOfWork,
    private readonly event: ServiceRuntime<never>['event'],
    private readonly scorer: MatchScorer,
    private readonly settings: MatchingSettings,
  ) {}

  // ---------------------------------------------------------------- forward: need → candidates

  /** Score every candidate for an OPEN need; keep each seller's best; retire dropped ones. */
  async matchNeed(s: MatchingStore, needId: string, ctx: EventCtx): Promise<void> {
    const need = await s.need(needId);
    if (!need || need.status !== 'OPEN' || need.expired) return;

    const districts = districtsNear([need.district]);
    const [listings, sellers] = await Promise.all([
      s.listingCandidates(need, {
        kinds: KindsForMode[need.mode],
        districts,
        limit: CANDIDATE_SCAN_LIMIT,
      }),
      s.sellerCandidates(need, {
        roles: RolesForMode[need.mode],
        districts,
        limit: CANDIDATE_SCAN_LIMIT,
      }),
    ]);
    const candidates: Candidate[] = [...listings, ...sellers];
    const signals = await s.signals([...new Set(candidates.map((c) => c.sellerId))]);

    const scored: ScoredCandidate[] = [];
    for (const candidate of candidates) {
      const r = this.scorer.score(need, candidate, signals.get(candidate.sellerId) ?? NO_SIGNALS);
      if (r) scored.push({ candidate, ...r });
    }
    const selected = selectBestPerSeller(scored, this.settings.minScore, this.settings.maxPerNeed);

    const existing = new Map((await s.matchesForNeed(needId)).map((m) => [m.sellerId, m]));
    for (const sel of selected) {
      await this.save(s, need, sel, existing.get(sel.candidate.sellerId) ?? null, ctx);
    }
    const kept = new Set(selected.map((x) => x.candidate.sellerId));
    const retired = [...existing.values()]
      .filter((m) => !kept.has(m.sellerId) && RETIRABLE.includes(m.status))
      .map((m) => m.id);
    if (retired.length > 0) await s.applyToMatches('CLOSE', { ids: retired });
  }

  // ---------------------------------------------------------------- reverse: candidate → needs

  /** A new listing or seller capability: score it against the newest related OPEN needs. */
  async matchCandidate(s: MatchingStore, candidate: Candidate, ctx: EventCtx): Promise<void> {
    const q = this.reverseQuery(candidate);
    if (!q) return;
    const needs = await s.openNeeds(q);
    if (needs.length === 0) return;

    const signals = (await s.signals([candidate.sellerId])).get(candidate.sellerId) ?? NO_SIGNALS;
    const existing = new Map(
      (
        await s.matchesOfSeller(
          candidate.sellerId,
          needs.map((n) => n.needId),
        )
      ).map((m) => [m.needId, m]),
    );

    for (const need of needs) {
      const r = this.scorer.score(need, candidate, signals);
      if (!r || r.score < this.settings.minScore) continue;
      const ex = existing.get(need.needId) ?? null;
      if (!ex) {
        if ((await s.liveMatchCount(need.needId)) >= this.settings.maxPerNeed) continue;
      } else if (ex.listingId !== candidateListingId(candidate) && r.score <= ex.score) {
        continue; // the seller's current candidate for this need is at least as good
      }
      await this.save(s, need, { candidate, ...r }, ex, ctx);
    }
  }

  private reverseQuery(c: Candidate): OpenNeedQuery | null {
    if (c.type === 'LISTING') {
      if (!c.available || c.quantityAvailable < 1) return null;
      return {
        categoryIds: [c.categoryId, ...(c.categoryParentId ? [c.categoryParentId] : [])],
        parentCategoryIds: [c.categoryId],
        modes: modesForKind(c.kind),
        districts: delivers(c.deliveryModes) ? null : districtsNear([c.district]),
        excludeRequesterId: c.sellerId,
        limit: this.settings.reverseScanLimit,
      };
    }
    const modes = modesForRoles(c.roles);
    if (!c.active || c.categoryIds.length === 0 || modes.length === 0) return null;
    return {
      categoryIds: c.categoryIds,
      parentCategoryIds: c.categoryIds,
      modes,
      districts: delivers(c.deliveryModes) ? null : districtsNear(c.serviceDistricts),
      excludeRequesterId: c.sellerId,
      limit: this.settings.reverseScanLimit,
    };
  }

  /** Insert (and announce) a new match, or refresh an existing one without re-announcing it. */
  private async save(
    s: MatchingStore,
    need: ScoringNeed,
    sel: ScoredCandidate,
    existing: MatchRecord | null,
    ctx: EventCtx,
  ): Promise<void> {
    const listingId = candidateListingId(sel.candidate);
    const write: MatchWrite = {
      listingId,
      candidateType: sel.candidate.type,
      score: sel.score,
      reasons: sel.reasons,
      scorer: this.scorer.name,
      status: existing ? rescoredStatus(existing) : 'NEW',
    };
    if (existing) {
      if (!sameWrite(existing, write)) await s.updateMatch(existing.id, write);
      return;
    }
    const id = uuidv7();
    const inserted = await s.insertMatch({
      ...write,
      id,
      needId: need.needId,
      sellerId: sel.candidate.sellerId,
    });
    if (!inserted) return; // created concurrently by another event; that one announced it
    await s.outbox(
      this.event(
        MatchingEvents.MatchFound,
        id,
        {
          matchId: id,
          needId: need.needId,
          requesterId: need.requesterId,
          sellerId: sel.candidate.sellerId,
          listingId,
          score: sel.score,
        },
        ctx,
      ),
    );
  }

  // ---------------------------------------------------------------- event handlers

  async onNeedFacts(
    s: MatchingStore,
    facts: NeedFacts,
    publishedAt: string | null,
    ctx: EventCtx,
  ): Promise<void> {
    await s.lockMatching();
    await s.upsertNeed(facts, publishedAt);
    await this.matchNeed(s, facts.needId, ctx);
  }

  async onListingPublished(s: MatchingStore, facts: ListingFacts, ctx: EventCtx): Promise<void> {
    await s.lockMatching();
    await s.upsertListing(facts);
    const listing = await s.listing(facts.listingId);
    if (listing) await this.matchCandidate(s, listing, ctx);
  }

  async onSellerCapabilities(
    s: MatchingStore,
    caps: Parameters<MatchingStore['upsertSeller']>[0],
    ctx: EventCtx,
  ): Promise<void> {
    await s.lockMatching();
    await s.upsertSeller(caps);
    const seller = await s.seller(caps.accountId);
    if (seller?.active) await this.matchCandidate(s, seller, ctx);
  }

  async onNeedStatusChanged(s: MatchingStore, needId: string, to: NeedStatus): Promise<void> {
    await s.setNeedStatus(needId, to);
    if (to !== 'OPEN') await s.applyToMatches('CLOSE', { needId });
  }

  async onOfferSubmitted(s: MatchingStore, needId: string, sellerId: string): Promise<void> {
    await s.applyToMatches('RESPOND', { needId, sellerId });
  }

  // ---------------------------------------------------------------- HTTP use cases

  /** The requester's ranked matches for their need. Anyone else gets 404 (no IDOR leak). */
  async listForNeed(
    needId: string,
    q: { cursor?: string | undefined; limit: number },
    ctx: RequestContext,
  ): Promise<Page<MatchRecord>> {
    const actor = requireActor(ctx);
    const need = await this.uow.store.need(needId);
    if (!need || need.requesterId !== actor.id) throw Errors.notFound('Need');
    return this.uow.store.pageForNeed(needId, cursorOf(q.cursor, 'number'), q.limit);
  }

  /** OPEN needs matched to the calling seller, newest match first. */
  listMine(
    q: { cursor?: string | undefined; limit: number },
    ctx: RequestContext,
  ): Promise<Page<MatchedNeed>> {
    const actor = requireActor(ctx);
    return this.uow.store.pageForSeller(actor.id, cursorOf(q.cursor, 'date'), q.limit);
  }

  /** Seller hides a matched need from their feed. Idempotent; only the match's seller may. */
  async dismiss(matchId: string, ctx: RequestContext): Promise<void> {
    const actor = requireActor(ctx);
    const m = await this.uow.store.match(matchId);
    if (!m || m.sellerId !== actor.id) throw Errors.notFound('Match');
    if (m.status === 'DISMISSED') return;
    transition(m.status, 'DISMISS'); // 409 when not allowed
    const changed = await this.uow.store.applyToMatches('DISMISS', { id: matchId });
    if (changed === 0) {
      // Lost a race (e.g. the need closed meanwhile): report the state we lost to.
      const now = await this.uow.store.match(matchId);
      if (now?.status !== 'DISMISSED') transition(now?.status ?? 'CLOSED', 'DISMISS');
    }
  }
}
