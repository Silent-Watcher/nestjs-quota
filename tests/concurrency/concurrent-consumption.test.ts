import { describe, expect, it } from 'vitest';
import { QuotaEngine } from '../../src/core/application/engine.js';
import { FakeClock } from '../../src/core/contracts/clock.js';
import { MemoryQuotaStore } from '../../src/stores/memory/memory-store.js';

describe('concurrent consumption (deterministic, no sleeping)', () => {
  it('100 simultaneous requests competing for 10 units: exactly 10 succeed', async () => {
    const clock = new FakeClock(0);
    const store = new MemoryQuotaStore({ clock });
    const engine = new QuotaEngine({ store, clock }, [
      { name: 'p', scope: 'tenant', window: { type: 'fixed', unit: 'day' }, limit: 10 },
    ]);

    const attempts = Array.from({ length: 100 }, () =>
      engine.consume({ applications: [{ policy: 'p', subject: 't1' }], context: {} }),
    );
    const results = await Promise.all(attempts);
    const allowedCount = results.filter((r) => r.decision.kind === 'allowed').length;
    expect(allowedCount).toBe(10);

    const final = await engine.getUsage('p', 't1');
    expect(final.used).toBe(10);
    expect(final.remaining).toBe(0);
  });

  it('two requests racing for the final unit: exactly one succeeds', async () => {
    const clock = new FakeClock(0);
    const store = new MemoryQuotaStore({ clock });
    const engine = new QuotaEngine({ store, clock }, [
      { name: 'p', scope: 'tenant', window: { type: 'fixed', unit: 'day' }, limit: 1 },
    ]);
    const [a, b] = await Promise.all([
      engine.consume({ applications: [{ policy: 'p', subject: 't1' }], context: {} }),
      engine.consume({ applications: [{ policy: 'p', subject: 't1' }], context: {} }),
    ]);
    const allowed = [a, b].filter((r) => r.decision.kind === 'allowed');
    expect(allowed.length).toBe(1);
  });

  it('concurrent multi-policy consumption never partially applies', async () => {
    const clock = new FakeClock(0);
    const store = new MemoryQuotaStore({ clock });
    const engine = new QuotaEngine({ store, clock }, [
      { name: 'a', scope: 'tenant', window: { type: 'fixed', unit: 'day' }, limit: 5 },
      { name: 'b', scope: 'tenant', window: { type: 'fixed', unit: 'day' }, limit: 5 },
    ]);
    const attempts = Array.from({ length: 20 }, () =>
      engine.consume({
        applications: [
          { policy: 'a', subject: 't1' },
          { policy: 'b', subject: 't1' },
        ],
        context: {},
      }),
    );
    await Promise.all(attempts);
    const a = await engine.getUsage('a', 't1');
    const b = await engine.getUsage('b', 't1');
    // Both buckets share the same limit and are always consumed together,
    // so their final usage must be identical -- no partial application.
    expect(a.used).toBe(b.used);
    expect(a.used).toBe(5);
  });

  it('concurrent duplicate idempotency keys charge exactly once', async () => {
    const clock = new FakeClock(0);
    const store = new MemoryQuotaStore({ clock });
    const engine = new QuotaEngine({ store, clock }, [
      { name: 'p', scope: 'tenant', window: { type: 'fixed', unit: 'day' }, limit: 10 },
    ]);
    const attempts = Array.from({ length: 10 }, () =>
      engine.consume({
        applications: [{ policy: 'p', subject: 't1' }],
        context: {},
        idempotencyKey: 'same-key',
      }),
    );
    await Promise.all(attempts);
    const final = await engine.getUsage('p', 't1');
    expect(final.used).toBe(1);
  });

  it('concurrent reserve calls never oversubscribe the bucket', async () => {
    const clock = new FakeClock(0);
    const store = new MemoryQuotaStore({ clock });
    const engine = new QuotaEngine({ store, clock }, [
      { name: 'p', scope: 'tenant', window: { type: 'fixed', unit: 'day' }, limit: 5 },
    ]);
    const attempts = Array.from({ length: 20 }, () =>
      engine.reserve({ policy: 'p', subject: 't1' }, {}).catch(() => null),
    );
    const results = await Promise.all(attempts);
    const succeeded = results.filter((r) => r !== null);
    expect(succeeded.length).toBe(5);
    const usage = await engine.getUsage('p', 't1');
    expect(usage.used).toBe(5);
  });

  it('concurrent commit/release races on the same reservation: only one wins', async () => {
    const clock = new FakeClock(0);
    const store = new MemoryQuotaStore({ clock });
    const engine = new QuotaEngine({ store, clock }, [
      { name: 'p', scope: 'tenant', window: { type: 'fixed', unit: 'day' }, limit: 5 },
    ]);
    const { handle } = await engine.reserve({ policy: 'p', subject: 't1' }, {});
    const [commitResult, releaseResult] = await Promise.allSettled([
      engine.commitReservation(handle.id),
      engine.releaseReservation(handle.id),
    ]);
    const outcomes = [commitResult.status, releaseResult.status];
    // Exactly one of commit/release should succeed; the other must fail
    // because the reservation is no longer pending.
    expect(outcomes.filter((s) => s === 'fulfilled').length).toBe(1);
  });
});
