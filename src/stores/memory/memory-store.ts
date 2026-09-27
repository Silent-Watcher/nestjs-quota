import type { Clock } from '../../core/contracts/clock.js';
import { SystemClock } from '../../core/contracts/clock.js';
import type {
  BatchOutcome,
  BucketRequest,
  BucketState,
  IdempotencyFingerprint,
  QuotaStore,
  ReservationRecord,
} from '../../core/contracts/store.js';
import { buildBucketKey, buildIdempotencyKey } from '../../core/domain/key.js';
import {
  IdempotencyConflictError,
  QuotaConfigurationError,
  ReservationExpiredError,
  ReservationNotFoundError,
} from '../../core/errors/errors.js';

interface Bucket {
  used: number;
  readonly resetAtMs: number;
}

interface IdempotencyRecord {
  readonly requestHash: string;
  readonly outcome: BatchOutcome;
  readonly expiresAtMs: number;
}

interface InternalReservation {
  readonly id: string;
  readonly bucketKey: string;
  readonly bucket: BucketRequest;
  readonly expiresAtMs: number;
  status: 'pending' | 'committed' | 'released';
}

export interface MemoryQuotaStoreOptions {
  readonly namespace?: string;
  readonly clock?: Clock;
  /**
   * If set, an interval (unref'd so it never keeps the process alive) that
   * periodically sweeps expired buckets/idempotency records/reservations.
   * Expiration is also enforced lazily on every access regardless of this
   * setting, so a sweep interval is an optimization, not a correctness
   * requirement.
   */
  readonly sweepIntervalMs?: number;
}

let reservationCounter = 0;
function nextReservationId(): string {
  reservationCounter += 1;
  return `resv_${Date.now().toString(36)}_${reservationCounter.toString(36)}`;
}

/**
 * Deterministic, concurrency-safe in-memory store.
 *
 * "Concurrency-safe" here means: safe under Node's single-threaded,
 * interleaved-async concurrency model. All bucket mutations in
 * `checkAndConsume` happen synchronously within one microtask turn (no
 * `await` between the check and the write), so two "simultaneous" async
 * calls cannot interleave mid-mutation.
 */
export class MemoryQuotaStore implements QuotaStore {
  private readonly namespace: string;
  private readonly clock: Clock;
  private readonly buckets = new Map<string, Bucket>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly reservations = new Map<string, InternalReservation>();
  private readonly sweepTimer?: ReturnType<typeof setInterval>;

  constructor(options: MemoryQuotaStoreOptions = {}) {
    this.namespace = options.namespace ?? 'quota';
    this.clock = options.clock ?? new SystemClock();
    if (options.sweepIntervalMs !== undefined) {
      this.sweepTimer = setInterval(() => this.sweep(), options.sweepIntervalMs);
      this.sweepTimer.unref?.();
    }
  }

  /** Stops the optional sweep interval, if one was configured. */
  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  private keyFor(bucket: Pick<BucketRequest, 'policy' | 'scope' | 'subject' | 'window'>): string {
    return buildBucketKey({
      namespace: this.namespace,
      policy: bucket.policy,
      scope: bucket.scope,
      subject: bucket.subject,
      window: bucket.window,
    });
  }

  private getBucket(key: string, resetAtMs: number): Bucket {
    const now = this.clock.now();
    const existing = this.buckets.get(key);
    if (existing && existing.resetAtMs > now) {
      return existing;
    }
    const fresh: Bucket = { used: 0, resetAtMs };
    this.buckets.set(key, fresh);
    return fresh;
  }

  private toState(request: Pick<BucketRequest, 'policy' | 'scope' | 'subject' | 'limit' | 'window'>, used: number): BucketState {
    return {
      policy: request.policy,
      scope: request.scope,
      subject: request.subject,
      limit: request.limit,
      used,
      remaining: Math.max(0, request.limit - used),
      resetAt: new Date(request.window.endMs),
    };
  }

  async check(buckets: readonly BucketRequest[]): Promise<BatchOutcome> {
    const states: BucketState[] = [];
    const violated: BucketState[] = [];
    for (const req of buckets) {
      const key = this.keyFor(req);
      const bucket = this.getBucket(key, req.window.endMs);
      const projected = bucket.used + req.cost;
      const state = this.toState(req, bucket.used);
      states.push(state);
      if (req.cost > req.limit || projected > req.limit) {
        violated.push(state);
      }
    }
    return { allowed: violated.length === 0, buckets: states, violated };
  }

  async checkAndConsume(
    buckets: readonly BucketRequest[],
    idempotency?: IdempotencyFingerprint,
  ): Promise<BatchOutcome> {
    if (idempotency) {
      const idemKey = buildIdempotencyKey(this.namespace, idempotency.key);
      const now = this.clock.now();
      const existing = this.idempotency.get(idemKey);
      if (existing && existing.expiresAtMs > now) {
        if (existing.requestHash !== idempotency.requestHash) {
          throw new IdempotencyConflictError(
            `idempotency key "${idempotency.key}" was already used with a different request`,
            idempotency.key,
          );
        }
        return existing.outcome;
      }
    }

    // Synchronous critical section: evaluate every bucket before mutating any of them.
    const keys = buckets.map((b) => this.keyFor(b));
    const currentUsed = buckets.map((b, i) => this.getBucket(keys[i] as string, b.window.endMs).used);
    const violated: BucketState[] = [];
    const states: BucketState[] = [];
    buckets.forEach((req, i) => {
      const used = currentUsed[i] as number;
      const projected = used + req.cost;
      if (req.cost > req.limit || projected > req.limit) {
        violated.push(this.toState(req, used));
      }
    });

    let outcome: BatchOutcome;
    if (violated.length > 0) {
      buckets.forEach((req, i) => states.push(this.toState(req, currentUsed[i] as number)));
      outcome = { allowed: false, buckets: states, violated };
    } else {
      buckets.forEach((req, i) => {
        const key = keys[i] as string;
        const bucket = this.getBucket(key, req.window.endMs);
        bucket.used += req.cost;
        states.push(this.toState(req, bucket.used));
      });
      outcome = { allowed: true, buckets: states, violated: [] };
    }

    if (idempotency) {
      const idemKey = buildIdempotencyKey(this.namespace, idempotency.key);
      this.idempotency.set(idemKey, {
        requestHash: idempotency.requestHash,
        outcome,
        expiresAtMs: this.clock.now() + idempotency.ttlMs,
      });
    }
    return outcome;
  }

  async getUsage(bucket: Omit<BucketRequest, 'cost'>): Promise<BucketState> {
    const key = this.keyFor(bucket);
    const b = this.getBucket(key, bucket.window.endMs);
    return this.toState(bucket, b.used);
  }

  async recordUsage(bucket: BucketRequest): Promise<BucketState> {
    const key = this.keyFor(bucket);
    const b = this.getBucket(key, bucket.window.endMs);
    b.used = Math.min(bucket.limit, b.used + bucket.cost);
    return this.toState(bucket, b.used);
  }

  async reserve(bucket: BucketRequest, leaseMs: number): Promise<ReservationRecord> {
    const key = this.keyFor(bucket);
    const b = this.getBucket(key, bucket.window.endMs);
    const projected = b.used + bucket.cost;
    if (bucket.cost > bucket.limit || projected > bucket.limit) {
      const state = this.toState(bucket, b.used);
      throw new QuotaConfigurationError(
        `reservation would exceed quota for policy "${bucket.policy}"`,
        { metadata: { ...state } },
      );
    }
    b.used = projected; // capacity is held immediately
    const id = nextReservationId();
    const now = this.clock.now();
    const record: InternalReservation = {
      id,
      bucketKey: key,
      bucket,
      expiresAtMs: now + leaseMs,
      status: 'pending',
    };
    this.reservations.set(id, record);
    return { id, bucket, createdAtMs: now, expiresAtMs: record.expiresAtMs, status: 'pending' };
  }

  private getLiveReservation(reservationId: string): InternalReservation {
    const record = this.reservations.get(reservationId);
    if (!record) {
      throw new ReservationNotFoundError(`reservation "${reservationId}" not found`, reservationId);
    }
    if (record.status === 'pending' && record.expiresAtMs <= this.clock.now()) {
      // Abandoned reservation: release its held capacity lazily on access.
      this.releaseHeldCapacity(record);
      record.status = 'released';
      throw new ReservationExpiredError(`reservation "${reservationId}" has expired`, reservationId);
    }
    if (record.status !== 'pending') {
      throw new ReservationNotFoundError(
        `reservation "${reservationId}" is not pending (status: ${record.status})`,
        reservationId,
      );
    }
    return record;
  }

  private releaseHeldCapacity(record: InternalReservation): void {
    const b = this.buckets.get(record.bucketKey);
    if (b) {
      b.used = Math.max(0, b.used - record.bucket.cost);
    }
  }

  async commitReservation(reservationId: string): Promise<BucketState> {
    const record = this.getLiveReservation(reservationId);
    record.status = 'committed';
    const b = this.buckets.get(record.bucketKey);
    const used = b ? b.used : record.bucket.cost;
    return this.toState(record.bucket, used);
  }

  async releaseReservation(reservationId: string): Promise<void> {
    const record = this.getLiveReservation(reservationId);
    this.releaseHeldCapacity(record);
    record.status = 'released';
  }

  private sweep(): void {
    const now = this.clock.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAtMs <= now) this.buckets.delete(key);
    }
    for (const [key, record] of this.idempotency) {
      if (record.expiresAtMs <= now) this.idempotency.delete(key);
    }
    for (const [id, record] of this.reservations) {
      if (record.status !== 'pending' || record.expiresAtMs <= now) this.reservations.delete(id);
    }
  }

  /** Test/inspection helper: number of live bucket entries currently tracked. */
  get size(): number {
    return this.buckets.size;
  }
}
