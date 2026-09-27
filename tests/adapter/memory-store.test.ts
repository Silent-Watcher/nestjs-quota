import { describe, expect, it } from 'vitest';
import { MemoryQuotaStore } from '../../src/stores/memory/memory-store.js';
import { FakeClock } from '../../src/core/contracts/clock.js';
import type { BucketRequest } from '../../src/core/contracts/store.js';
import { toPolicyName, toScopeName, toSubjectId } from '../../src/core/domain/identity.js';

function bucket(overrides: Partial<BucketRequest> = {}): BucketRequest {
  return {
    policy: toPolicyName('p'),
    scope: toScopeName('tenant'),
    subject: toSubjectId('t1'),
    window: { startMs: 0, endMs: 1000 },
    limit: 3,
    cost: 1,
    ...overrides,
  };
}

describe('MemoryQuotaStore', () => {
  it('starts buckets at zero usage', async () => {
    const store = new MemoryQuotaStore({ clock: new FakeClock(0) });
    const state = await store.getUsage(bucket());
    expect(state.used).toBe(0);
    expect(state.remaining).toBe(3);
  });

  it('does not let usage go negative on release', async () => {
    const clock = new FakeClock(0);
    const store = new MemoryQuotaStore({ clock });
    const record = await store.reserve(bucket(), 1000);
    await store.releaseReservation(record.id);
    await store.releaseReservation(record.id).catch(() => undefined); // second release should not double-subtract
    const state = await store.getUsage(bucket());
    expect(state.used).toBeGreaterThanOrEqual(0);
  });

  it('expires a bucket at the window boundary', async () => {
    const clock = new FakeClock(0);
    const store = new MemoryQuotaStore({ clock });
    await store.checkAndConsume([bucket({ window: { startMs: 0, endMs: 100 } })]);
    clock.set(50);
    let state = await store.getUsage(bucket({ window: { startMs: 0, endMs: 100 } }));
    expect(state.used).toBe(1);
    clock.set(150);
    // A new window instance for the same subject starts fresh usage.
    state = await store.getUsage(bucket({ window: { startMs: 100, endMs: 200 } }));
    expect(state.used).toBe(0);
  });

  it('keeps distinct subjects fully isolated', async () => {
    const store = new MemoryQuotaStore({ clock: new FakeClock(0) });
    await store.checkAndConsume([bucket({ subject: toSubjectId('a') })]);
    const a = await store.getUsage(bucket({ subject: toSubjectId('a') }));
    const b = await store.getUsage(bucket({ subject: toSubjectId('b') }));
    expect(a.used).toBe(1);
    expect(b.used).toBe(0);
  });

  it('sweep() removes expired buckets, idempotency records, and terminal reservations', async () => {
    const clock = new FakeClock(0);
    const store = new MemoryQuotaStore({ clock });
    await store.checkAndConsume([bucket({ window: { startMs: 0, endMs: 100 } })], {
      key: 'k',
      requestHash: 'h',
      ttlMs: 50,
    });
    const record = await store.reserve(bucket({ subject: toSubjectId('resv') }), 10);
    await store.releaseReservation(record.id);

    expect(store.size).toBeGreaterThan(0);
    clock.set(1000);
    // @ts-expect-error accessing private for the purpose of this white-box test
    store.sweep();
    expect(store.size).toBe(0);
  });

  it('dispose() clears the sweep interval without throwing', () => {
    const store = new MemoryQuotaStore({ sweepIntervalMs: 10_000 });
    expect(() => store.dispose()).not.toThrow();
  });
});
