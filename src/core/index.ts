export type { Clock } from './contracts/clock.js';
export { SystemClock, FakeClock } from './contracts/clock.js';

export type {
  QuotaStore,
  BucketRequest,
  BucketState,
  BatchOutcome,
  IdempotencyFingerprint,
  ReservationRecord,
} from './contracts/store.js';

export type {
  Brand,
  ScopeName,
  SubjectId,
  PolicyName,
  ResolvedScope,
} from './domain/identity.js';
export { toScopeName, toSubjectId, toPolicyName, assertSafeComponent } from './domain/identity.js';

export {
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
  assertNonNegativeSafeInteger,
  assertPositiveSafeInteger,
} from './domain/numeric.js';

export { buildBucketKey, buildIdempotencyKey, buildReservationKey } from './domain/key.js';
export type { BucketKeyParams } from './domain/key.js';

export type {
  FixedWindowUnit,
  FixedWindowSpec,
  WindowSpec,
  WindowInstance,
} from './windows/window.js';
export { resolveFixedWindow, currentWindow, windowKeyFragment } from './windows/window.js';

export type { QuotaPolicy, RawQuotaPolicyInput } from './policies/policy.js';
export { definePolicy, resolveLimit } from './policies/policy.js';

export {
  QuotaErrorCode,
  QuotaError,
  QuotaExceededError,
  QuotaStoreError,
  InvalidQuotaPolicyError,
  InvalidQuotaCostError,
  InvalidQuotaScopeError,
  IdempotencyConflictError,
  ReservationExpiredError,
  ReservationNotFoundError,
  QuotaConfigurationError,
  isQuotaError,
} from './errors/errors.js';
export type { QuotaErrorOptions } from './errors/errors.js';

export type {
  QuotaStatus,
  QuotaDecision,
  QuotaDecisionKind,
  QuotaResult,
  ReservationHandle,
} from './application/types.js';

export {
  QuotaEngine,
} from './application/engine.js';
export type {
  QuotaEngineOptions,
  QuotaEngineHooks,
  QuotaOperationRequest,
  PolicyApplication,
  FailureMode,
} from './application/engine.js';
