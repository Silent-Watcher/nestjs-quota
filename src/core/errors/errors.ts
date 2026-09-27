/**
 * Typed, stable, machine-readable error model.
 *
 * Every error carries an `errorCode` from `QuotaErrorCode` that is safe to
 * branch on across package versions (within the same major version).
 * Human-readable `message` text may change; `errorCode` will not.
 */
export const QuotaErrorCode = {
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  QUOTA_STORE_UNAVAILABLE: 'QUOTA_STORE_UNAVAILABLE',
  INVALID_QUOTA_POLICY: 'INVALID_QUOTA_POLICY',
  INVALID_QUOTA_COST: 'INVALID_QUOTA_COST',
  INVALID_QUOTA_SCOPE: 'INVALID_QUOTA_SCOPE',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  RESERVATION_EXPIRED: 'RESERVATION_EXPIRED',
  RESERVATION_NOT_FOUND: 'RESERVATION_NOT_FOUND',
  QUOTA_CONFIGURATION_ERROR: 'QUOTA_CONFIGURATION_ERROR',
} as const;

export type QuotaErrorCode = (typeof QuotaErrorCode)[keyof typeof QuotaErrorCode];

export interface QuotaErrorOptions {
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/** Base class for every error raised by this package. */
export abstract class QuotaError extends Error {
  abstract readonly errorCode: QuotaErrorCode;
  readonly metadata: Readonly<Record<string, unknown>>;

  constructor(message: string, options: QuotaErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.metadata = options.metadata ?? {};
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class QuotaExceededError extends QuotaError {
  readonly errorCode = QuotaErrorCode.QUOTA_EXCEEDED;
  constructor(
    message: string,
    readonly details: {
      readonly policy: string;
      readonly scope: string;
      readonly subject: string;
      readonly limit: number;
      readonly used: number;
      readonly remaining: number;
      readonly resetAt: Date;
      readonly requestedCost: number;
    },
    options: QuotaErrorOptions = {},
  ) {
    super(message, { ...options, metadata: { ...details, ...options.metadata } });
  }
}

export class QuotaStoreError extends QuotaError {
  readonly errorCode = QuotaErrorCode.QUOTA_STORE_UNAVAILABLE;
  constructor(message: string, options: QuotaErrorOptions = {}) {
    super(message, options);
  }
}

export class InvalidQuotaPolicyError extends QuotaError {
  readonly errorCode = QuotaErrorCode.INVALID_QUOTA_POLICY;
}

export class InvalidQuotaCostError extends QuotaError {
  readonly errorCode = QuotaErrorCode.INVALID_QUOTA_COST;
}

export class InvalidQuotaScopeError extends QuotaError {
  readonly errorCode = QuotaErrorCode.INVALID_QUOTA_SCOPE;
}

export class IdempotencyConflictError extends QuotaError {
  readonly errorCode = QuotaErrorCode.IDEMPOTENCY_CONFLICT;
  constructor(message: string, readonly idempotencyKey: string, options: QuotaErrorOptions = {}) {
    super(message, { ...options, metadata: { idempotencyKey, ...options.metadata } });
  }
}

export class ReservationExpiredError extends QuotaError {
  readonly errorCode = QuotaErrorCode.RESERVATION_EXPIRED;
  constructor(message: string, readonly reservationId: string, options: QuotaErrorOptions = {}) {
    super(message, { ...options, metadata: { reservationId, ...options.metadata } });
  }
}

export class ReservationNotFoundError extends QuotaError {
  readonly errorCode = QuotaErrorCode.RESERVATION_NOT_FOUND;
  constructor(message: string, readonly reservationId: string, options: QuotaErrorOptions = {}) {
    super(message, { ...options, metadata: { reservationId, ...options.metadata } });
  }
}

export class QuotaConfigurationError extends QuotaError {
  readonly errorCode = QuotaErrorCode.QUOTA_CONFIGURATION_ERROR;
}

/** Type guard: is this any error raised by this package? */
export function isQuotaError(err: unknown): err is QuotaError {
  return err instanceof QuotaError;
}
