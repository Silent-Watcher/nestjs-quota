import { SetMetadata } from '@nestjs/common';
import { QUOTA_METADATA_KEY, SKIP_QUOTA_METADATA_KEY } from '../tokens/tokens.js';

export type QuotaMode = 'check' | 'consume' | 'reserve';

export interface QuotaRouteApplication {
  readonly policy: string;
  /** Static cost override for this policy on this route. Ignored if the module-level costResolver returns a value. */
  readonly cost?: number;
}

export interface QuotaRouteOptions {
  readonly policies: readonly (string | QuotaRouteApplication)[];
  /** Defaults to the module-level default (see `QuotaModuleOptions.defaultMode`, itself defaulting to 'consume'). */
  readonly mode?: QuotaMode;
  /** Lease duration in ms, only used when mode is 'reserve'. */
  readonly reservationLeaseMs?: number;
}

/**
 * Declares which quota polic(ies) apply to a route.
 *
 * This decorator only attaches metadata — it never performs I/O. The
 * `QuotaGuard` reads this metadata at request time and does the actual
 * check/consume/reserve.
 *
 * ```ts
 * @Quota('user-minute')
 * @Quota({ policies: ['tenant-monthly', 'user-minute'] })
 * ```
 */
export function Quota(policyOrOptions: string | QuotaRouteOptions): MethodDecorator & ClassDecorator {
  const options: QuotaRouteOptions =
    typeof policyOrOptions === 'string' ? { policies: [policyOrOptions] } : policyOrOptions;
  if (!options.policies || options.policies.length === 0) {
    throw new Error('@Quota() requires at least one policy');
  }
  return SetMetadata(QUOTA_METADATA_KEY, options);
}

/**
 * Marks a route as exempt from quota enforcement even if a `@Quota()`
 * guard is applied at the controller or global level.
 */
export function SkipQuota(): MethodDecorator & ClassDecorator {
  return SetMetadata(SKIP_QUOTA_METADATA_KEY, true);
}
