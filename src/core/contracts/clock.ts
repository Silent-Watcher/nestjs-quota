/**
 * Clock abstraction.
 *
 * The engine never calls `Date.now()` directly. All time-dependent logic
 * (window boundaries, TTLs, reservation leases, idempotency expiry) goes
 * through a `Clock` so that:
 *
 *  - tests can inject deterministic time instead of sleeping
 *  - a host application could, in principle, supply a synchronized/skewed
 *    clock strategy for distributed deployments
 */
export interface Clock {
  /** Current time in epoch milliseconds (UTC). */
  now(): number;
}

/** Production clock backed by the system clock. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/**
 * Deterministic clock for tests. Time only moves when `advance`/`set` is
 * called explicitly.
 */
export class FakeClock implements Clock {
  private current: number;

  constructor(startMs: number = 0) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  set(ms: number): void {
    this.current = ms;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}
