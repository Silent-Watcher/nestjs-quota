import type { WindowSpec } from '../windows/window.js';
import { toPolicyName, type PolicyName, type ScopeName, toScopeName } from '../domain/identity.js';
import { InvalidQuotaPolicyError } from '../errors/errors.js';

/**
 * A quota policy: "N units per window, per scope".
 *
 * `limit` may be a static number, or resolved dynamically per-context
 * (e.g. based on the caller's billing plan). It is intentionally *not*
 * coupled to any billing system — the host application supplies a
 * `limitResolver` if the limit depends on external state.
 */
export interface QuotaPolicy<TContext = unknown> {
  readonly name: PolicyName;
  readonly scope: ScopeName;
  readonly window: WindowSpec;
  /** Static limit. Ignored if `limitResolver` is provided. */
  readonly limit?: number;
  /** Dynamic limit resolver, e.g. plan-based. */
  readonly limitResolver?: (context: TContext) => number | Promise<number>;
  /** Default cost of a single operation against this policy. Defaults to 1. */
  readonly defaultCost?: number;
}

export interface RawQuotaPolicyInput<TContext = unknown> {
  readonly name: string;
  readonly scope: string;
  readonly window: WindowSpec;
  readonly limit?: number;
  readonly limitResolver?: (context: TContext) => number | Promise<number>;
  readonly defaultCost?: number;
}

/** Validates and normalizes a raw policy definition supplied by the host application. */
export function definePolicy<TContext = unknown>(
  input: RawQuotaPolicyInput<TContext>,
): QuotaPolicy<TContext> {
  let name: PolicyName;
  let scope: ScopeName;
  try {
    name = toPolicyName(input.name);
    scope = toScopeName(input.scope);
  } catch (err) {
    throw new InvalidQuotaPolicyError((err as Error).message, { cause: err });
  }

  if (input.limit === undefined && input.limitResolver === undefined) {
    throw new InvalidQuotaPolicyError(
      `policy "${input.name}" must define either "limit" or "limitResolver"`,
    );
  }
  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit) || input.limit < 0) {
      throw new InvalidQuotaPolicyError(
        `policy "${input.name}" has invalid static limit: ${String(input.limit)}`,
      );
    }
  }
  if (input.defaultCost !== undefined) {
    if (!Number.isInteger(input.defaultCost) || input.defaultCost <= 0) {
      throw new InvalidQuotaPolicyError(
        `policy "${input.name}" has invalid defaultCost: ${String(input.defaultCost)}`,
      );
    }
  }
  if (!input.window || input.window.type !== 'fixed') {
    throw new InvalidQuotaPolicyError(
      `policy "${input.name}" must define a supported window`,
    );
  }

  return {
    name,
    scope,
    window: input.window,
    limit: input.limit,
    limitResolver: input.limitResolver,
    defaultCost: input.defaultCost ?? 1,
  };
}

/** Resolves the effective limit for a policy, given the request context. */
export async function resolveLimit<TContext>(
  policy: QuotaPolicy<TContext>,
  context: TContext,
): Promise<number> {
  if (policy.limitResolver) {
    const resolved = await policy.limitResolver(context);
    if (!Number.isInteger(resolved) || resolved < 0) {
      throw new InvalidQuotaPolicyError(
        `policy "${policy.name}" limitResolver returned an invalid limit: ${String(resolved)}`,
      );
    }
    return resolved;
  }
  // definePolicy guarantees one of the two is present.
  return policy.limit as number;
}
