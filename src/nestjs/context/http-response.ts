import type { QuotaStatus } from '../../core/application/types.js';
import type { QuotaHeaderOptions } from '../module/quota-module-options.js';

export interface ResponseLike {
  setHeader(name: string, value: string): void;
}

/** Applies standards-leaning rate-limit headers for the most-constrained status. */
export function applyQuotaHeaders(
  res: ResponseLike,
  statuses: readonly QuotaStatus[],
  headerOptions: QuotaHeaderOptions | undefined,
  retryAfterSeconds?: number,
): void {
  if (headerOptions?.enabled === false) return;
  if (statuses.length === 0) return;
  const prefix = headerOptions?.prefix ?? 'X-RateLimit';

  // The most-constrained (least remaining relative to limit) status drives the headers.
  const primary = [...statuses].sort((a, b) => a.remaining - b.remaining)[0] as QuotaStatus;
  res.setHeader(`${prefix}-Limit`, String(primary.limit));
  res.setHeader(`${prefix}-Remaining`, String(primary.remaining));
  res.setHeader(`${prefix}-Reset`, String(Math.ceil(primary.resetAt.getTime() / 1000)));
  if (retryAfterSeconds !== undefined) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
  }
}
