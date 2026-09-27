import type { ModuleMetadata, Type } from '@nestjs/common';
import type { QuotaStore } from '../../core/contracts/store.js';
import type { FailureMode, QuotaEngineHooks } from '../../core/application/engine.js';
import type { RawQuotaPolicyInput } from '../../core/policies/policy.js';
import type { QuotaMode } from '../decorators/quota.decorator.js';
import type { CostResolver, IdentityResolver } from '../context/quota-context.js';
import type { Clock } from '../../core/contracts/clock.js';

export interface QuotaHeaderOptions {
  /** Emit `RateLimit-*` / `X-RateLimit-*` style response headers. Defaults to true. */
  readonly enabled?: boolean;
  /** Header name prefix. Defaults to 'X-RateLimit'. */
  readonly prefix?: string;
}

export interface QuotaModuleOptions<TContext = unknown> {
  readonly store: QuotaStore;
  /**
   * `TContext` here should match whatever object `QuotaGuard` actually
   * passes through as the engine's `context` at request time — in this
   * NestJS integration, that is always the framework's request object
   * itself (see `QuotaGuard.canActivate`, which calls
   * `engine.consume({ applications, context: request })`). So a
   * `limitResolver` on one of these policies receives the request, not an
   * arbitrary domain type — e.g. `QuotaModule.forRoot<Request>({ ... })`
   * with a `limitResolver: (req) => req.auth?.plan === 'pro' ? ... : ...`.
   * See `examples/basic-app` for a complete example.
   */
  readonly policies: readonly RawQuotaPolicyInput<TContext>[];
  /** 'open' allows requests through when the store is unavailable; 'closed' (default) rejects them with a 5xx. */
  readonly failureMode?: FailureMode;
  readonly clock?: Clock;
  readonly namespace?: string;
  readonly headers?: QuotaHeaderOptions;
  /** Resolves the subject id for a policy application. Required unless every route provides its own via route metadata (not currently supported — always required). */
  readonly identityResolver: IdentityResolver;
  /** Resolves the cost of the current operation. Defaults to each policy's `defaultCost`. */
  readonly costResolver?: CostResolver;
  /** Default guard behavior when a route's `@Quota()` does not specify `mode`. Defaults to 'consume'. */
  readonly defaultMode?: QuotaMode;
  readonly hooks?: QuotaEngineHooks;
}

export interface QuotaModuleAsyncOptions<TContext = unknown>
  extends Pick<ModuleMetadata, 'imports'> {
  readonly useFactory: (
    ...args: unknown[]
  ) => QuotaModuleOptions<TContext> | Promise<QuotaModuleOptions<TContext>>;
  readonly inject?: Array<Type<unknown> | string | symbol>;
}
