import { Errors, uuidv7, type Actor, type RequestContext } from '@dorkar/kernel';
import {
  assertTermsConsistent,
  assertWindow,
  defaultTerms,
  MAX_AVAILABILITY_WINDOW_DAYS,
  MAX_BLOCK_DAYS,
  mergeBusy,
  type Interval,
  type RentalListing,
  type RentalTerms,
} from '../domain/booking';
import type { Block, RentalStore, RentalUnitOfWork, TermsInput } from './ports';

const requireActor = (ctx: RequestContext): Actor => {
  if (!ctx.actor) throw Errors.unauthenticated();
  return ctx.actor;
};

/** Only the owner sees that a listing's calendar is theirs to manage; others get a 404. */
async function ownedListing(
  s: RentalStore,
  listingId: string,
  actor: Actor,
): Promise<RentalListing> {
  const listing = await s.listing(listingId);
  if (!listing || listing.sellerId !== actor.id) throw Errors.notFound('Listing');
  return listing;
}

/** Rental terms and the calendar (availability and owner blocks). */
export class CalendarService {
  constructor(private readonly uow: RentalUnitOfWork) {}

  async getTerms(listingId: string): Promise<RentalTerms> {
    const listing = await this.uow.store.listing(listingId);
    if (!listing) throw Errors.notFound('Listing');
    return (await this.uow.store.terms(listingId)) ?? defaultTerms(listingId);
  }

  async putTerms(listingId: string, input: TermsInput, ctx: RequestContext): Promise<RentalTerms> {
    const actor = requireActor(ctx);
    return this.uow.transaction(async (s) => {
      await ownedListing(s, listingId, actor);
      assertTermsConsistent(input);
      const terms = await s.putTerms(listingId, input);
      await s.audit(ctx, {
        action: 'rental.terms-updated',
        targetType: 'listing',
        targetId: listingId,
        metadata: {
          instantBook: input.instantBook,
          minDurationHours: input.minDurationHours,
          maxDurationDays: input.maxDurationDays,
          advanceNoticeHours: input.advanceNoticeHours,
          bufferHours: input.bufferHours,
          hasDeposit: input.deposit !== null,
        },
      });
      return terms;
    });
  }

  /** Busy intervals only: never who booked, nor whether an interval is a block. */
  async availability(listingId: string, from: Date, to: Date): Promise<Interval[]> {
    assertWindow(from, to, MAX_AVAILABILITY_WINDOW_DAYS, 'Availability');
    const listing = await this.uow.store.listing(listingId);
    if (!listing) throw Errors.notFound('Listing');
    return mergeBusy(await this.uow.store.busy(listingId, from, to), from, to);
  }

  async listBlocks(listingId: string, from: Date, to: Date, ctx: RequestContext): Promise<Block[]> {
    const actor = requireActor(ctx);
    assertWindow(from, to, MAX_BLOCK_DAYS, 'Blocks');
    await ownedListing(this.uow.store, listingId, actor);
    return this.uow.store.blocks(listingId, from, to);
  }

  async addBlock(
    listingId: string,
    input: { startAt: Date; endAt: Date; reason: string | null },
    ctx: RequestContext,
  ): Promise<Block> {
    const actor = requireActor(ctx);
    assertWindow(input.startAt, input.endAt, MAX_BLOCK_DAYS, 'Block');
    return this.uow.transaction(async (s) => {
      await ownedListing(s, listingId, actor);
      const now = await s.now();
      if (input.endAt.getTime() <= now.getTime()) {
        throw Errors.validation('Block: the period is already over.');
      }
      const id = uuidv7();
      await s.insertSlot({
        id,
        listingId,
        startAt: input.startAt,
        endAt: input.endAt,
        kind: 'BLOCK',
        refId: null,
        reason: input.reason,
        createdBy: actor.id,
      });
      await s.audit(ctx, {
        action: 'rental.block-added',
        targetType: 'listing',
        targetId: listingId,
        metadata: { blockId: id },
      });
      return {
        id,
        listingId,
        startAt: input.startAt,
        endAt: input.endAt,
        reason: input.reason,
        createdAt: now,
      };
    });
  }

  async removeBlock(listingId: string, blockId: string, ctx: RequestContext): Promise<void> {
    const actor = requireActor(ctx);
    await this.uow.transaction(async (s) => {
      await ownedListing(s, listingId, actor);
      if (!(await s.removeBlock(listingId, blockId))) throw Errors.notFound('Block');
      await s.audit(ctx, {
        action: 'rental.block-removed',
        targetType: 'listing',
        targetId: listingId,
        metadata: { blockId },
      });
    });
  }
}
