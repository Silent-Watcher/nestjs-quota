import type { PolicyName, ScopeName, SubjectId } from '../domain/identity.js';
import type { WindowInstance } from '../windows/window.js';

/**
 * One bucket to evaluate/consume within a single atomic operation. The
 * engine translates a resolved set of (policy, scope, subject) pairs for a
 * request into a `BucketRequest[]` and hands the whole batch to the store
 * so multi-policy consumption can be made atomic by stores that support it.
 */
export interface BucketRequest {
  readonly policy: PolicyName;
  readonly scope: ScopeName;
  readonly subject: SubjectId;
  readonly window: WindowInstance;
  readonly limit: number;
  readonly cost: number;
}

export interface BucketState {
  readonly policy: PolicyName;
  readonly scope: ScopeName;
  readonly subject: SubjectId;
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  readonly resetAt: Date;
}

/** Outcome of a `check` or `consume` batch operation across all buckets. */
export interface BatchOutcome {
  readonly allowed: boolean;
  /** Per-bucket state *after* the operation would apply (or did apply, if allowed and consumed). */
  readonly buckets: readonly BucketState[];
  /** If not allowed, the bucket(s) that caused rejection. */
  readonly violated: readonly BucketState[];
}

export interface IdempotencyFingerprint {
  readonly key: string;
  /** Hash/serialization of the semantically-relevant request shape, used to detect conflicting reuse. */
  readonly requestHash: string;
  readonly ttlMs: number;
}

export interface ReservationRecord {
  readonly id: string;
  readonly bucket: BucketRequest;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly status: 'pending' | 'committed' | 'released';
}

/**
 * Storage abstraction the quota engine depends on. The engine never knows
 * whether this is backed by memory, Redis, or something else.
 *
 * Implementations MUST make `checkAndConsume` atomic across all buckets in
 * the batch: either every bucket's usage is incremented, or none is.
 */
export interface QuotaStore {
  /** Read-only evaluation: would this batch be allowed, without consuming anything. */
  check(buckets: readonly BucketRequest[]): Promise<BatchOutcome>;

  /**
   * Atomically evaluates and consumes usage across all buckets in the
   * batch. If any bucket would be exceeded, no bucket is modified.
   *
   * `idempotency`, when provided, must guarantee that a retried call with
   * the same key and an identical `requestHash` is a no-op returning the
   * original outcome, while a reused key with a different `requestHash`
   * rejects with a conflict (surfaced by the engine as
   * `IdempotencyConflictError`).
   */
  checkAndConsume(
    buckets: readonly BucketRequest[],
    idempotency?: IdempotencyFingerprint,
  ): Promise<BatchOutcome>;

  /** Reads current usage for a single bucket without modifying it. */
  getUsage(bucket: Omit<BucketRequest, 'cost'>): Promise<BucketState>;

  /**
   * Records usage after the fact (e.g. post-handler metering) without a
   * prior admission check. Still bounded by `limit`; if recording would
   * exceed it, usage is clamped at `limit` and the returned state reflects
   * that (the caller decides whether this should raise an error).
   */
  recordUsage(bucket: BucketRequest): Promise<BucketState>;

  /** Reserves capacity for later commit/release. Reservations expire at `leaseMs` from now. */
  reserve(bucket: BucketRequest, leaseMs: number): Promise<ReservationRecord>;

  /** Permanently consumes a pending reservation. */
  commitReservation(reservationId: string): Promise<BucketState>;

  /** Returns reserved capacity without consuming it. */
  releaseReservation(reservationId: string): Promise<void>;
}
