import type { Clock } from '../contracts/clock.js';

/**
 * Window unit for fixed windows. Calendar-aware units (day/month) are
 * computed in UTC to avoid local-timezone ambiguity.
 */
export type FixedWindowUnit = 'second' | 'minute' | 'hour' | 'day' | 'month';

export interface FixedWindowSpec {
  readonly type: 'fixed';
  readonly unit: FixedWindowUnit;
  /** Number of units per window, e.g. { unit: 'minute', size: 5 } = 5-minute windows. Defaults to 1. */
  readonly size?: number;
}

/**
 * Window specification. Only `fixed` is implemented today; the
 * discriminated union leaves room for `rolling` / `calendar` / `custom`
 * window kinds later without redesigning callers, which only ever consume
 * the resolved `WindowInstance`.
 */
export type WindowSpec = FixedWindowSpec;

/**
 * A concrete, resolved instance of a window: a half-open interval
 * `[startMs, endMs)` in epoch milliseconds, UTC.
 */
export interface WindowInstance {
  readonly startMs: number;
  readonly endMs: number;
}

function unitMillis(unit: Exclude<FixedWindowUnit, 'month'>): number {
  switch (unit) {
    case 'second':
      return 1_000;
    case 'minute':
      return 60_000;
    case 'hour':
      return 3_600_000;
    case 'day':
      return 86_400_000;
  }
}

/**
 * Resolves the fixed window instance that contains `atMs`.
 *
 * Semantics: `[start, end)`. `size` groups multiple units into one window,
 * anchored at the UTC epoch (for sub-month units) or at the first day of
 * the month (for month-based windows), so windows are stable and
 * reproducible across processes without shared coordination.
 */
export function resolveFixedWindow(spec: FixedWindowSpec, atMs: number): WindowInstance {
  const size = spec.size ?? 1;
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`window size must be a positive integer, received: ${String(size)}`);
  }

  if (spec.unit === 'month') {
    const date = new Date(atMs);
    const year = date.getUTCFullYear();
    const monthIndex = date.getUTCMonth(); // 0-based
    const groupIndex = Math.floor(monthIndex / size);
    const startMonthIndex = groupIndex * size;

    const startMs = Date.UTC(year, startMonthIndex, 1, 0, 0, 0, 0);
    const endMs = Date.UTC(year, startMonthIndex + size, 1, 0, 0, 0, 0);
    return { startMs, endMs };
  }

  const base = unitMillis(spec.unit);
  const windowLength = base * size;
  const startMs = Math.floor(atMs / windowLength) * windowLength;
  const endMs = startMs + windowLength;
  return { startMs, endMs };
}

/** Resolves the current window instance for `spec` using `clock`. */
export function currentWindow(spec: WindowSpec, clock: Clock): WindowInstance {
  return resolveFixedWindow(spec, clock.now());
}

/**
 * A short, deterministic, collision-resistant identifier for a window
 * instance, suitable for embedding in a storage key.
 */
export function windowKeyFragment(spec: WindowSpec, instance: WindowInstance): string {
  return `${spec.unit}:${spec.size ?? 1}:${instance.startMs}`;
}
