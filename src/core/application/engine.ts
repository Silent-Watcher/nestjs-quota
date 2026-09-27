import type { Clock } from '../contracts/clock.js';
import { SystemClock } from '../contracts/clock.js';
import type { BucketRequest, IdempotencyFingerprint, QuotaStore } from '../contracts/store.js';
import { toPolicyName, toSubjectId, type PolicyName } from '../domain/identity.js';
import { assertNonNegativeSafeInteger, isPositiveSafeInteger } from '../domain/numeric.js';
import {
  IdempotencyConflictError,
  InvalidQuotaCostError,
  InvalidQuotaPolicyError,
  QuotaConfigurationError,
  QuotaError,
  QuotaExceededError,
  QuotaStoreError,
  ReservationExpiredError,
  ReservationNotFoundError,
} from '../errors/errors.js';
import { definePolicy, resolveLimit, type QuotaPolicy, type RawQuotaPolicyInput } from '../policies/policy.js';
import { currentWindow } from '../windows/window.js';
import type { QuotaDecision, QuotaResult, QuotaStatus, ReservationHandle } from './types.js';

export type FailureMode = 'open' | 'closed';

/** One policy application within a (possibly multi-policy) operation. */
export interface PolicyApplication {
  readonly policy: string;
  readonly subject: string;
  /** Overrides the policy's defaultCost for this call. */
  readonly cost?: number;
}

export interface QuotaOperationRequest<TContext = unknown> {
  readonly applications: readonly PolicyApplication[];
  readonly context: TContext;
  readonly idempotencyKey?: string;
}

export interface QuotaEngineOptions {
  readonly store: QuotaStore;
  /** Defaults to `new SystemClock()` when omitted. */
  readonly clock?: Clock;
  readonly failureMode?: FailureMode;
  /** TTL for idempotency records. Defaults to 24 hours. */
  readonly idempotencyTtlMs?: number;
  /** Hooks for observability. All are optional and synchronous-fire-and-forget. */
  readonly hooks?: QuotaEngineHooks;
}

export interface QuotaEngineHooks {
  onAllowed?(decision: QuotaDecision): void;
  onRejected?(decision: QuotaDecision): void;
  onUsageRecorded?(status: QuotaStatus): void;
  onReservationCreated?(handle: ReservationHandle): void;
  onReservationCommitted?(handle: ReservationHandle): void;
  onReservationReleased?(reservationId: string): void;
  onStoreFailure?(error: unknown): void;
  onIdempotencyHit?(key: string): void;
}

function toStatus(bucket: { policy: PolicyName; limit: number; used: number; remaining: number; resetAt: Date }): QuotaStatus {
  return {
    policy: bucket.policy,
    limit: bucket.limit,
    used: bucket.used,
    remaining: bucket.remaining,
    resetAt: bucket.resetAt,
  };
}

/** Deterministic, order-independent hash of a request shape, for idempotency conflict detection. */
function hashRequest(buckets: readonly BucketRequest[]): string {
  const normalized = buckets
    .map((b) => `${b.policy}|${b.scope}|${b.subject}|${b.window.startMs}|${b.window.endMs}|${b.limit}|${b.cost}`)
    .sort()
    .join('~');
  // Small, dependency-free non-cryptographic hash (FNV-1a). Sufficient for
  // conflict detection; not used for any security-sensitive purpose.
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * The core, framework-agnostic quota engine. Owns the policy registry and
 * coordinates policy resolution, window resolution, and store I/O behind a
 * configured failure mode.
 */
export class QuotaEngine<TContext = unknown> {
  private readonly policies = new Map<PolicyName, QuotaPolicy<TContext>>();
  private readonly store: QuotaStore;
  private readonly clock: Clock;
  private readonly failureMode: FailureMode;
  private readonly idempotencyTtlMs: number;
  private readonly hooks: QuotaEngineHooks;

  constructor(options: QuotaEngineOptions, policies: readonly RawQuotaPolicyInput<TContext>[] = []) {
    this.store = options.store;
    this.clock = options.clock ?? new SystemClock();
    this.failureMode = options.failureMode ?? 'closed';
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? 24 * 60 * 60 * 1000;
    this.hooks = options.hooks ?? {};
    for (const raw of policies) {
      this.registerPolicy(raw);
    }
  }

  registerPolicy(raw: RawQuotaPolicyInput<TContext>): void {
    const policy = definePolicy(raw);
    if (this.policies.has(policy.name)) {
      throw new QuotaConfigurationError(`policy "${policy.name}" is already registered`);
    }
    this.policies.set(policy.name, policy);
  }

  getPolicy(name: string): QuotaPolicy<TContext> {
    const policyName = toPolicyName(name);
    const policy = this.policies.get(policyName);
    if (!policy) {
      throw new InvalidQuotaPolicyError(`unknown policy: "${name}"`);
    }
    return policy;
  }

  private async buildBuckets(request: QuotaOperationRequest<TContext>): Promise<BucketRequest[]> {
    if (request.applications.length === 0) {
      throw new QuotaConfigurationError('at least one policy application is required');
    }
    const buckets: BucketRequest[] = [];
    for (const app of request.applications) {
      const policy = this.getPolicy(app.policy);
      const limit = await resolveLimit(policy, request.context);
      const cost = app.cost ?? policy.defaultCost ?? 1;
      if (!isPositiveSafeInteger(cost)) {
        throw new InvalidQuotaCostError(
          `invalid cost for policy "${policy.name}": ${String(cost)}`,
        );
      }
      const subject = toSubjectId(app.subject);
      const window = currentWindow(policy.window, this.clock);
      buckets.push({
        policy: policy.name,
        scope: policy.scope,
        subject,
        window,
        limit,
        cost,
      });
    }
    return buckets;
  }

  private buildDecision(outcome: {
    allowed: boolean;
    buckets: readonly { policy: PolicyName; limit: number; used: number; remaining: number; resetAt: Date }[];
    violated: readonly { policy: PolicyName; limit: number; used: number; remaining: number; resetAt: Date }[];
  }): QuotaDecision {
    const statuses = outcome.buckets.map(toStatus);
    if (outcome.allowed) {
      return { kind: 'allowed', statuses };
    }
    const violated = outcome.violated.map(toStatus);
    const soonestResetMs = Math.min(...violated.map((v) => v.resetAt.getTime()));
    const retryAfterSeconds = Math.max(0, Math.ceil((soonestResetMs - this.clock.now()) / 1000));
    return { kind: 'rejected', statuses, violated, retryAfterSeconds };
  }

  private handleStoreFailure(err: unknown, allBuckets: readonly BucketRequest[]): QuotaResult {
    this.hooks.onStoreFailure?.(err);
    if (this.failureMode === 'open') {
      const now = this.clock.now();
      const statuses: QuotaStatus[] = allBuckets.map((b) => ({
        policy: b.policy,
        limit: b.limit,
        used: 0,
        remaining: b.limit,
        resetAt: new Date(b.window.endMs),
      }));
      void now;
      const decision: QuotaDecision = { kind: 'allowed', statuses };
      return { decision, degraded: true };
    }
    throw new QuotaStoreError('quota store is unavailable', { cause: err });
  }

  /** Evaluates whether the operation would be allowed, without consuming anything. */
  async check(request: QuotaOperationRequest<TContext>): Promise<QuotaResult> {
    const buckets = await this.buildBuckets(request);
    try {
      const outcome = await this.store.check(buckets);
      const decision = this.buildDecision(outcome);
      return { decision, degraded: false };
    } catch (err) {
      if (err instanceof QuotaError) throw err;
      return this.handleStoreFailure(err, buckets);
    }
  }

  /** Atomically checks and consumes usage across all policy applications. */
  async consume(request: QuotaOperationRequest<TContext>): Promise<QuotaResult> {
    const buckets = await this.buildBuckets(request);
    let fingerprint: IdempotencyFingerprint | undefined;
    if (request.idempotencyKey !== undefined) {
      fingerprint = {
        key: request.idempotencyKey,
        requestHash: hashRequest(buckets),
        ttlMs: this.idempotencyTtlMs,
      };
    }
    try {
      const outcome = await this.store.checkAndConsume(buckets, fingerprint);
      const decision = this.buildDecision(outcome);
      if (decision.kind === 'allowed') {
        this.hooks.onAllowed?.(decision);
      } else {
        this.hooks.onRejected?.(decision);
      }
      return { decision, degraded: false };
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        this.hooks.onIdempotencyHit?.(request.idempotencyKey as string);
        throw err;
      }
      if (err instanceof QuotaError) throw err;
      return this.handleStoreFailure(err, buckets);
    }
  }

  /** Throws `QuotaExceededError` if the operation would not be allowed; otherwise consumes and returns the decision. */
  async consumeOrThrow(request: QuotaOperationRequest<TContext>): Promise<QuotaResult> {
    const result = await this.consume(request);
    if (result.decision.kind === 'rejected') {
      const violated = result.decision.violated?.[0];
      const app =
        request.applications.find((a) => a.policy === violated?.policy) ?? request.applications[0];
      if (!app) {
        // Unreachable in practice: `consume` already validated via
        // `buildBuckets` that at least one application was provided.
        throw new QuotaConfigurationError('at least one policy application is required');
      }
      throw new QuotaExceededError(
        `quota exceeded for policy "${violated?.policy ?? app.policy}"`,
        {
          policy: String(violated?.policy ?? app.policy),
          scope: String(this.getPolicy(app.policy).scope),
          subject: app.subject,
          limit: violated?.limit ?? 0,
          used: violated?.used ?? 0,
          remaining: violated?.remaining ?? 0,
          resetAt: violated?.resetAt ?? new Date(this.clock.now()),
          requestedCost: app.cost ?? this.getPolicy(app.policy).defaultCost ?? 1,
        },
      );
    }
    return result;
  }

  /** Records actual usage after the fact (e.g. post-handler metering), without a prior admission check. */
  async recordUsage(request: QuotaOperationRequest<TContext>): Promise<readonly QuotaStatus[]> {
    const buckets = await this.buildBuckets(request);
    const statuses: QuotaStatus[] = [];
    for (const bucket of buckets) {
      try {
        const state = await this.store.recordUsage(bucket);
        const status = toStatus(state);
        statuses.push(status);
        this.hooks.onUsageRecorded?.(status);
      } catch (err) {
        if (err instanceof QuotaError) throw err;
        if (this.failureMode === 'closed') {
          throw new QuotaStoreError('quota store is unavailable while recording usage', { cause: err });
        }
        this.hooks.onStoreFailure?.(err);
      }
    }
    return statuses;
  }

  async getUsage(policyName: string, subject: string): Promise<QuotaStatus> {
    const policy = this.getPolicy(policyName);
    const window = currentWindow(policy.window, this.clock);
    const limit = await resolveLimit(policy, undefined as TContext);
    const state = await this.store.getUsage({
      policy: policy.name,
      scope: policy.scope,
      subject: toSubjectId(subject),
      window,
      limit,
    });
    return toStatus(state);
  }

  /** Reserves capacity for a single policy application. Reservations are single-policy by design (see docs/design.md). */
  async reserve(
    application: PolicyApplication,
    context: TContext,
    leaseMs = 30_000,
  ): Promise<{ handle: ReservationHandle; result: QuotaResult }> {
    assertNonNegativeSafeInteger(leaseMs, 'leaseMs');
    const buckets = await this.buildBuckets({ applications: [application], context });
    const bucket = buckets[0];
    if (!bucket) {
      throw new QuotaConfigurationError('at least one policy application is required');
    }
    try {
      const record = await this.store.reserve(bucket, leaseMs);
      const handle: ReservationHandle = {
        id: record.id,
        policy: bucket.policy,
        expiresAt: new Date(record.expiresAtMs),
      };
      this.hooks.onReservationCreated?.(handle);
      const status: QuotaStatus = {
        policy: bucket.policy,
        limit: bucket.limit,
        used: 0,
        remaining: bucket.limit,
        resetAt: new Date(bucket.window.endMs),
      };
      return { handle, result: { decision: { kind: 'allowed', statuses: [status] }, degraded: false } };
    } catch (err) {
      if (err instanceof QuotaError) throw err;
      const result = this.handleStoreFailure(err, [bucket]);
      return {
        handle: { id: '', policy: bucket.policy, expiresAt: new Date(this.clock.now() + leaseMs) },
        result,
      };
    }
  }

  async commitReservation(reservationId: string): Promise<QuotaStatus> {
    try {
      const state = await this.store.commitReservation(reservationId);
      const status = toStatus(state);
      this.hooks.onReservationCommitted?.({
        id: reservationId,
        policy: state.policy,
        expiresAt: state.resetAt,
      });
      return status;
    } catch (err) {
      if (err instanceof ReservationExpiredError || err instanceof ReservationNotFoundError) {
        throw err;
      }
      throw new QuotaStoreError('failed to commit reservation', { cause: err });
    }
  }

  async releaseReservation(reservationId: string): Promise<void> {
    try {
      await this.store.releaseReservation(reservationId);
      this.hooks.onReservationReleased?.(reservationId);
    } catch (err) {
      if (err instanceof ReservationExpiredError || err instanceof ReservationNotFoundError) {
        throw err;
      }
      throw new QuotaStoreError('failed to release reservation', { cause: err });
    }
  }
}
