import { AppError, Errors, uuidv7, type Cursor, type RequestContext } from '@dorkar/kernel';
import {
  assertPolicyConsistent,
  parseSelector,
  type Policy,
  type PolicyAction,
  type PolicyScope,
  type Requirement,
} from '../domain/policy';
import type { VerificationKind } from '../domain/verification';
import type { Page, PolicyInput, VerificationStore, VerificationUnitOfWork } from './ports';

export interface PolicyDraft {
  name: string;
  action: PolicyAction;
  scope: PolicyScope;
  selector: Record<string, unknown>;
  requirement: Requirement;
  kinds: VerificationKind[];
  active?: boolean | undefined;
  priority?: number | undefined;
}

export type PolicyPatch = { [K in keyof PolicyDraft]?: PolicyDraft[K] | undefined } & {
  /** Optimistic concurrency: the version the editor saw. */
  version?: number | undefined;
};

const requireActor = (ctx: RequestContext) => {
  if (!ctx.actor) throw Errors.unauthenticated();
  return ctx.actor;
};

/** Snapshot recorded in the audit log (no PII: policies are configuration). */
const snapshot = (p: Policy) => ({
  name: p.name,
  action: p.action,
  scope: p.scope,
  selector: p.selector,
  requirement: p.requirement,
  kinds: p.kinds,
  active: p.active,
  priority: p.priority,
  version: p.version,
});

function normalize(d: PolicyDraft & { active: boolean; priority: number }): PolicyInput {
  const kinds = [...new Set(d.kinds)];
  const input: PolicyInput = {
    name: d.name,
    action: d.action,
    scope: d.scope,
    selector: parseSelector(d.scope, d.selector),
    requirement: d.requirement,
    kinds,
    active: d.active,
    priority: d.priority,
  };
  assertPolicyConsistent(input);
  return input;
}

/** Verification policies are data: edited by admins, versioned, audited with before/after. */
export class PolicyService {
  constructor(private readonly uow: VerificationUnitOfWork) {}

  list(after: Cursor | null, limit: number): Promise<Page<Policy>> {
    return this.uow.store.policies(after, limit);
  }

  async create(draft: PolicyDraft, ctx: RequestContext): Promise<Policy> {
    const actor = requireActor(ctx);
    const input = normalize({
      ...draft,
      active: draft.active ?? true,
      priority: draft.priority ?? 0,
    });
    return this.uow.transaction(async (s) => {
      const p = await s.insertPolicy(uuidv7(), input, actor.id);
      await s.audit(ctx, {
        action: 'verification.policy.created',
        actorType: 'ADMIN',
        targetType: 'verification_policy',
        targetId: p.id,
        metadata: { before: null, after: snapshot(p) },
      });
      return p;
    });
  }

  async update(id: string, patch: PolicyPatch, ctx: RequestContext): Promise<Policy> {
    return this.change(id, patch, 'verification.policy.updated', ctx);
  }

  async deactivate(id: string, ctx: RequestContext): Promise<Policy> {
    return this.change(id, { active: false }, 'verification.policy.deactivated', ctx);
  }

  private async change(
    id: string,
    patch: PolicyPatch,
    action: string,
    ctx: RequestContext,
  ): Promise<Policy> {
    const actor = requireActor(ctx);
    return this.uow.transaction(async (s: VerificationStore) => {
      const current = await s.policy(id, true);
      if (!current) throw Errors.notFound('Policy');
      if (patch.version !== undefined && patch.version !== current.version) {
        throw Errors.conflict('This policy was changed by someone else. Reload and try again.', {
          currentVersion: current.version,
        });
      }
      const input = normalize({
        name: patch.name ?? current.name,
        action: patch.action ?? current.action,
        scope: patch.scope ?? current.scope,
        selector: patch.selector ?? current.selector,
        requirement: patch.requirement ?? current.requirement,
        kinds: patch.kinds ?? current.kinds,
        active: patch.active ?? current.active,
        priority: patch.priority ?? current.priority,
      });
      if (JSON.stringify(input) === JSON.stringify(normalize({ ...current }))) return current;
      const next = await s.updatePolicy(id, current.version, input, actor.id);
      if (!next) throw new AppError('CONFLICT', 'This policy was changed meanwhile. Try again.');
      await s.audit(ctx, {
        action,
        actorType: 'ADMIN',
        targetType: 'verification_policy',
        targetId: id,
        metadata: { before: snapshot(current), after: snapshot(next) },
      });
      return next;
    });
  }
}
