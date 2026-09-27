import type { ExecutionContext } from '@nestjs/common';

/**
 * Everything the guard/interceptor needs to resolve identity and cost for
 * a given policy, for the current request. `raw` is the Nest
 * `ExecutionContext`, so resolvers can reach into whatever the host
 * application already attaches to the request (auth user, tenant, etc).
 */
export interface QuotaExecutionContext {
  readonly raw: ExecutionContext;
  readonly policy: string;
}

/**
 * Resolves the subject id for a given policy/request. Applications must
 * derive this from already-authenticated context (e.g. `req.user.tenantId`)
 * — never from unauthenticated, user-controlled request fields — since the
 * resolved subject is exactly what quota accounting is keyed on.
 */
export type IdentityResolver = (ctx: QuotaExecutionContext) => string | Promise<string>;

/** Resolves the cost of the current operation for a given policy/request. Defaults to the policy's `defaultCost`. */
export type CostResolver = (ctx: QuotaExecutionContext) => number | Promise<number>;
