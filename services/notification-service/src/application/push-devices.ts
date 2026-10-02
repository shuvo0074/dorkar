import { Errors, sha256, uuidv7, type Logger, type RequestContext } from '@dorkar/kernel';
import { MAX_ACTIVE_PUSH_DEVICES, type PushDevice, type PushPlatform } from '../domain/push';
import type { PushDeviceUnitOfWork } from './ports';

const requireActor = (ctx: RequestContext) => {
  if (!ctx.actor) throw Errors.unauthenticated();
  return ctx.actor;
};

/** The caller's push devices. Tokens go in, never come back out. */
export class PushDeviceService {
  constructor(
    private readonly uow: PushDeviceUnitOfWork,
    private readonly logger: Logger,
  ) {}

  /**
   * Registers (or refreshes) a device. A token is one physical app install: if another account
   * registered it, it now belongs to the caller (the previous account signed out on that device).
   * Keeps at most MAX_ACTIVE_PUSH_DEVICES active, deactivating the least recently registered.
   */
  async register(
    input: { platform: PushPlatform; token: string },
    ctx: RequestContext,
  ): Promise<PushDevice> {
    const actor = requireActor(ctx);
    const tokenHash = sha256(input.token).toString('hex');
    const { device, previousOwnerId, trimmed } = await this.uow.transaction(async (s) => {
      await s.lockAccount(actor.id);
      const r = await s.register({
        id: uuidv7(),
        accountId: actor.id,
        platform: input.platform,
        token: input.token,
        tokenHash,
      });
      return { ...r, trimmed: await s.trimActive(actor.id, MAX_ACTIVE_PUSH_DEVICES) };
    });
    this.logger.info(
      { deviceId: device.id, platform: device.platform, moved: previousOwnerId !== null, trimmed },
      'push device registered',
    );
    return device;
  }

  list(ctx: RequestContext): Promise<PushDevice[]> {
    return this.uow.store.listActive(requireActor(ctx).id);
  }

  async remove(id: string, ctx: RequestContext): Promise<void> {
    if (!(await this.uow.store.remove(id, requireActor(ctx).id))) {
      throw Errors.notFound('Push device'); // others' devices look exactly like missing ones
    }
  }
}
