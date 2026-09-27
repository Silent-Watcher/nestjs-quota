/**
 * Numeric safety helpers.
 *
 * The core engine works exclusively with non-negative safe integers.
 * Anything else (NaN, Infinity, negative numbers, non-integers, unsafe
 * integers) is rejected at the boundary rather than silently coerced,
 * because silent coercion is how quota accounting gets corrupted.
 */

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

export function assertNonNegativeSafeInteger(value: unknown, label: string): number {
  if (!isNonNegativeSafeInteger(value)) {
    throw new Error(
      `${label} must be a non-negative safe integer, received: ${String(value)}`,
    );
  }
  return value;
}

export function assertPositiveSafeInteger(value: unknown, label: string): number {
  if (!isPositiveSafeInteger(value)) {
    throw new Error(
      `${label} must be a positive safe integer, received: ${String(value)}`,
    );
  }
  return value;
}
