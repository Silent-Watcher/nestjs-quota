import type { PolicyName } from '../domain/identity.js';

/** Per-request usage/quota snapshot for a single policy, safe to expose to callers. */
export interface QuotaStatus {
  readonly policy: PolicyName;
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  readonly resetAt: Date;
}

export type QuotaDecisionKind = 'allowed' | 'rejected';

/** The overall decision for a (possibly multi-policy) quota operation. */
export interface QuotaDecision {
  readonly kind: QuotaDecisionKind;
  readonly statuses: readonly QuotaStatus[];
  /** Present only when kind === 'rejected': the statuses that caused rejection. */
  readonly violated?: readonly QuotaStatus[];
  /** Seconds the caller should wait before retrying, derived from the soonest reset among violated policies. */
  readonly retryAfterSeconds?: number;
}

/**
 * Result of an operation performed under a configured failure mode. When
 * the store is unavailable and failureMode is 'open', `degraded` is true
 * and `decision.kind` is 'allowed' even though the store could not be
 * consulted.
 */
export interface QuotaResult {
  readonly decision: QuotaDecision;
  readonly degraded: boolean;
}

export interface ReservationHandle {
  readonly id: string;
  readonly policy: PolicyName;
  readonly expiresAt: Date;
}
