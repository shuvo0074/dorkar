import {
  ProfileEvents,
  type AccountStatus,
  type DeliveryMode,
  type District,
  type SellerRole,
} from '@dorkar/contracts';
import { Errors, type RequestContext, type ServiceRuntime } from '@dorkar/kernel';
import {
  assertCapabilitiesComplete,
  assertNoContactInfo,
  dedupe,
  defaultDisplayName,
  type Badge,
  type Profile,
  type ReputationSummary,
  type SellerCapabilities,
} from '../domain/profile';
import type { ProfilePatch, ProfileStore, ProfileUnitOfWork, PublicCard } from './ports';

export interface PublicProfile {
  profile: Profile;
  capabilities: SellerCapabilities | null;
  reputation: ReputationSummary | null;
  badges: Badge[];
}

const requireActor = (ctx: RequestContext) => {
  if (!ctx.actor) throw Errors.unauthenticated();
  return ctx.actor;
};

/** Profile use cases. Each mutation writes its state and its outbox event in one transaction. */
export class ProfileService {
  constructor(
    private readonly uow: ProfileUnitOfWork,
    private readonly event: ServiceRuntime<never>['event'],
  ) {}

  async getMine(ctx: RequestContext): Promise<PublicProfile> {
    const actor = requireActor(ctx);
    // The AccountCreated event may not have arrived yet: create the default lazily (idempotent).
    const profile = await this.uow.store.ensure(actor.id, defaultDisplayName(actor.id));
    return this.compose(this.uow.store, profile);
  }

  async updateMine(patch: ProfilePatch, ctx: RequestContext): Promise<PublicProfile> {
    const actor = requireActor(ctx);
    assertNoContactInfo('display name', patch.displayName);
    assertNoContactInfo('bio', patch.bio);
    assertNoContactInfo('area', patch.area);
    return this.uow.transaction(async (s) => {
      await s.ensure(actor.id, defaultDisplayName(actor.id));
      const profile = await s.update(actor.id, patch);
      await s.outbox(
        this.event(
          ProfileEvents.ProfileUpdated,
          actor.id,
          {
            accountId: actor.id,
            displayName: profile.displayName,
            userType: profile.userType,
            district: profile.district,
          },
          ctx,
        ),
      );
      return this.compose(s, profile);
    });
  }

  async setCapabilities(
    input: {
      roles: SellerRole[];
      categoryIds: string[];
      serviceDistricts: District[];
      deliveryModes: DeliveryMode[];
      active: boolean;
    },
    ctx: RequestContext,
  ): Promise<SellerCapabilities> {
    const actor = requireActor(ctx);
    const c: SellerCapabilities = {
      accountId: actor.id,
      roles: dedupe(input.roles),
      categoryIds: dedupe(input.categoryIds),
      serviceDistricts: dedupe(input.serviceDistricts),
      deliveryModes: dedupe(input.deliveryModes),
      active: input.active,
    };
    assertCapabilitiesComplete(c);
    return this.uow.transaction(async (s) => {
      await s.ensure(actor.id, defaultDisplayName(actor.id));
      await s.setCapabilities(c);
      await s.outbox(this.event(ProfileEvents.SellerCapabilitiesChanged, actor.id, c, ctx));
      return c;
    });
  }

  async getPublic(accountId: string): Promise<PublicProfile> {
    const profile = await this.uow.store.get(accountId);
    if (!profile || profile.hidden) throw Errors.notFound('Profile');
    return this.compose(this.uow.store, profile);
  }

  cards(ids: readonly string[]): Promise<PublicCard[]> {
    return this.uow.store.cards(dedupe(ids).slice(0, 100));
  }

  // ---- event handlers (called inside the inbox transaction) ----

  async onAccountCreated(s: ProfileStore, accountId: string): Promise<void> {
    await s.ensure(accountId, defaultDisplayName(accountId));
  }

  async onAccountStatusChanged(
    s: ProfileStore,
    accountId: string,
    to: AccountStatus,
  ): Promise<void> {
    await s.ensure(accountId, defaultDisplayName(accountId));
    await s.setHidden(accountId, to === 'BANNED' || to === 'DELETED');
  }

  private async compose(s: ProfileStore, profile: Profile): Promise<PublicProfile> {
    const [capabilities, reputation, badges] = await Promise.all([
      s.capabilities(profile.accountId),
      s.reputation(profile.accountId),
      s.badges(profile.accountId),
    ]);
    return { profile, capabilities, reputation, badges };
  }
}
