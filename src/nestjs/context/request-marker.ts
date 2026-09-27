import type { QuotaStatus } from '../../core/application/types.js';

/**
 * Attached to the request object once a `QuotaGuard` has processed it, so
 * that a second guard instance accidentally registered on the same request
 * (global guard + controller guard, or two `@UseGuards(QuotaGuard)`) does
 * not consume quota twice. See docs/design.md, "Avoiding double charging".
 */
export const QUOTA_REQUEST_STATE = Symbol('QUOTA_REQUEST_STATE');

export interface QuotaRequestState {
  readonly handled: true;
  readonly statuses: readonly QuotaStatus[];
}

export interface QuotaCarryingRequest {
  [QUOTA_REQUEST_STATE]?: QuotaRequestState;
}
