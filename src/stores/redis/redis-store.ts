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
import { buildBucketKey, buildIdempotencyKey, buildReservationKey } from '../../core/domain/key.js';
import {
  IdempotencyConflictError,
  QuotaStoreError,
  ReservationExpiredError,
  ReservationNotFoundError,
} from '../../core/errors/errors.js';
import {
  CHECK_AND_CONSUME_SCRIPT,
  COMMIT_RESERVATION_SCRIPT,
  RECORD_USAGE_SCRIPT,
  RELEASE_RESERVATION_SCRIPT,
  RESERVE_SCRIPT,
} from './lua-scripts.js';
import type { RedisLikeClient } from './redis-client.js';

export interface RedisQuotaStoreOptions {
  readonly client: RedisLikeClient;
  readonly namespace?: string;
  readonly clock?: Clock;
}

let reservationCounter = 0;
function nextReservationId(): string {
  reservationCounter += 1;
  return `resv_${Date.now().toString(36)}_${reservationCounter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function ttlFor(bucket: Pick<BucketRequest, 'window'>, nowMs: number): number {
  return Math.max(1000, bucket.window.endMs - nowMs);
}

function wrapRedisError(err: unknown): never {
  throw new QuotaStoreError('redis operation failed', { cause: err });
}

/**
 * Production Redis-backed store. All multi-bucket and read-modify-write
 * operations are performed via Lua scripts (see `lua-scripts.ts`) so Redis
 * executes them atomically — no naive GET-then-SET race windows.
 *
 * `ioredis` (or any client structurally matching `RedisLikeClient`) is an
 * optional peer dependency: this module never imports it directly.
 */
export class RedisQuotaStore implements QuotaStore {
  private readonly client: RedisLikeClient;
  private readonly namespace: string;
  private readonly clock: Clock;

  constructor(options: RedisQuotaStoreOptions) {
    this.client = options.client;
    this.namespace = options.namespace ?? 'quota';
    this.clock = options.clock ?? new SystemClock();
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
    // Read-only snapshot. Not a linearizable multi-key read (Redis has no
    // atomic MGET-with-consistency guarantee beyond MULTI, which is
    // unnecessary here since nothing is mutated); acceptable for advisory
    // "would this be allowed" checks. Use `checkAndConsume` for admission
    // decisions that must be atomic.
    try {
      const states: BucketState[] = [];
      const violated: BucketState[] = [];
      for (const req of buckets) {
        const raw = await this.client.get(this.keyFor(req));
        const used = raw ? Number.parseInt(raw, 10) : 0;
        const state = this.toState(req, used);
        states.push(state);
        if (req.cost > req.limit || used + req.cost > req.limit) {
          violated.push(state);
        }
      }
      return { allowed: violated.length === 0, buckets: states, violated };
    } catch (err) {
      wrapRedisError(err);
    }
  }

  async checkAndConsume(
    buckets: readonly BucketRequest[],
    idempotency?: IdempotencyFingerprint,
  ): Promise<BatchOutcome> {
    const now = this.clock.now();
    const keys = buckets.map((b) => this.keyFor(b));
    const idemKey = idempotency ? buildIdempotencyKey(this.namespace, idempotency.key) : '';
    const args: Array<string | number> = [
      idemKey,
      idempotency?.ttlMs ?? 0,
      idempotency?.requestHash ?? '',
      now,
      buckets.length,
    ];
    for (const b of buckets) {
      args.push(b.limit, b.cost, ttlFor(b, now));
    }

    let raw: unknown;
    try {
      raw = await this.client.eval(CHECK_AND_CONSUME_SCRIPT, keys.length, ...keys, ...args);
    } catch (err) {
      wrapRedisError(err);
    }

    if (!Array.isArray(raw)) {
      throw new QuotaStoreError('malformed response from quota store', {
        metadata: { raw },
      });
    }

    const status = Number(raw[0]);
    if (status === -1) {
      throw new IdempotencyConflictError(
        `idempotency key "${idempotency?.key}" was already used with a different request`,
        idempotency?.key ?? '',
      );
    }

    if (status === 2) {
      // Idempotent replay: reconstruct the outcome from the stored payload.
      const payload = String(raw[1] ?? '');
      const usedValues = payload.split(',').map((v) => Number.parseInt(v, 10));
      const states = buckets.map((b, i) => this.toState(b, usedValues[i] ?? 0));
      const violated = states.filter((s, i) => (buckets[i] as BucketRequest).cost > s.limit || s.used > s.limit);
      return { allowed: violated.length === 0, buckets: states, violated };
    }

    const allowed = status === 1;
    const usedValues = raw.slice(2).map((v) => Number(v));
    const states = buckets.map((b, i) => this.toState(b, usedValues[i] ?? 0));
    const violated = allowed ? [] : states.filter((s, i) => {
      const b = buckets[i] as BucketRequest;
      return b.cost > s.limit || s.used + b.cost > s.limit;
    });
    return { allowed, buckets: states, violated };
  }

  async getUsage(bucket: Omit<BucketRequest, 'cost'>): Promise<BucketState> {
    try {
      const raw = await this.client.get(this.keyFor(bucket));
      const used = raw ? Number.parseInt(raw, 10) : 0;
      return this.toState(bucket, used);
    } catch (err) {
      wrapRedisError(err);
    }
  }

  async recordUsage(bucket: BucketRequest): Promise<BucketState> {
    const now = this.clock.now();
    const key = this.keyFor(bucket);
    try {
      const raw = await this.client.eval(
        RECORD_USAGE_SCRIPT,
        1,
        key,
        bucket.limit,
        bucket.cost,
        ttlFor(bucket, now),
      );
      const used = Array.isArray(raw) ? Number(raw[0]) : 0;
      return this.toState(bucket, used);
    } catch (err) {
      wrapRedisError(err);
    }
  }

  async reserve(bucket: BucketRequest, leaseMs: number): Promise<ReservationRecord> {
    const now = this.clock.now();
    const id = nextReservationId();
    const bucketKey = this.keyFor(bucket);
    const reservationKey = buildReservationKey(this.namespace, id);
    try {
      const raw = await this.client.eval(
        RESERVE_SCRIPT,
        2,
        bucketKey,
        reservationKey,
        bucket.limit,
        bucket.cost,
        ttlFor(bucket, now),
        leaseMs,
        id,
        now,
        bucket.policy,
        bucket.scope,
        bucket.subject,
        bucket.window.endMs,
      );
      if (!Array.isArray(raw) || Number(raw[0]) !== 1) {
        const used = Array.isArray(raw) ? Number(raw[1]) : bucket.limit;
        throw new QuotaStoreError(`reservation would exceed quota for policy "${bucket.policy}"`, {
          metadata: { used, limit: bucket.limit },
        });
      }
      return {
        id,
        bucket,
        createdAtMs: now,
        expiresAtMs: now + leaseMs,
        status: 'pending',
      };
    } catch (err) {
      if (err instanceof QuotaStoreError) throw err;
      wrapRedisError(err);
    }
  }

  async commitReservation(reservationId: string): Promise<BucketState> {
    const reservationKey = buildReservationKey(this.namespace, reservationId);
    let raw: unknown;
    try {
      raw = await this.client.eval(COMMIT_RESERVATION_SCRIPT, 1, reservationKey, this.clock.now());
    } catch (err) {
      wrapRedisError(err);
    }
    if (!Array.isArray(raw)) {
      throw new QuotaStoreError('malformed response from quota store');
    }
    const code = Number(raw[0]);
    if (code === -1) throw new ReservationNotFoundError(`reservation "${reservationId}" not found`, reservationId);
    if (code === -2) throw new ReservationExpiredError(`reservation "${reservationId}" has expired`, reservationId);
    const used = Number(raw[1] ?? 0);
    const policy = String(raw[2] ?? '') as BucketState['policy'];
    const scope = String(raw[3] ?? '') as BucketState['scope'];
    const subject = String(raw[4] ?? '') as BucketState['subject'];
    const limit = Number(raw[5] ?? used);
    const resetAtMs = Number(raw[6] ?? this.clock.now());
    return {
      policy,
      scope,
      subject,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      resetAt: new Date(resetAtMs),
    };
  }

  async releaseReservation(reservationId: string): Promise<void> {
    const reservationKey = buildReservationKey(this.namespace, reservationId);
    let raw: unknown;
    try {
      raw = await this.client.eval(RELEASE_RESERVATION_SCRIPT, 1, reservationKey, this.clock.now());
    } catch (err) {
      wrapRedisError(err);
    }
    if (!Array.isArray(raw) || Number(raw[0]) !== 1) {
      throw new ReservationNotFoundError(`reservation "${reservationId}" not found or not pending`, reservationId);
    }
  }
}
