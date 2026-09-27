import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaEngine } from '../../src/core/application/engine.js';
import { FakeClock } from '../../src/core/contracts/clock.js';
import { MemoryQuotaStore } from '../../src/stores/memory/memory-store.js';
import {
  IdempotencyConflictError,
  InvalidQuotaCostError,
  QuotaExceededError,
  QuotaStoreError,
} from '../../src/core/errors/errors.js';
import type { QuotaStore } from '../../src/core/contracts/store.js';

function buildEngine(overrides: Partial<{ failureMode: 'open' | 'closed'; store: QuotaStore }> = {}) {
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const store = overrides.store ?? new MemoryQuotaStore({ clock });
  const engine = new QuotaEngine(
    { store, clock, failureMode: overrides.failureMode ?? 'closed' },
    [
      { name: 'user-minute', scope: 'user', window: { type: 'fixed', unit: 'minute' }, limit: 3 },
      { name: 'tenant-day', scope: 'tenant', window: { type: 'fixed', unit: 'day' }, limit: 5 },
    ],
  );
  return { engine, store, clock };
}

describe('QuotaEngine.consume', () => {
  it('allows a request below the limit', async () => {
    const { engine } = buildEngine();
    const result = await engine.consume({
      applications: [{ policy: 'user-minute', subject: 'u1' }],
      context: {},
    });
    expect(result.decision.kind).toBe('allowed');
    expect(result.decision.statuses[0]?.remaining).toBe(2);
  });

  it('allows exactly the final unit and then rejects the next one', async () => {
    const { engine } = buildEngine();
    for (let i = 0; i < 3; i++) {
      const r = await engine.consume({ applications: [{ policy: 'user-minute', subject: 'u1' }], context: {} });
      expect(r.decision.kind).toBe('allowed');
    }
    const rejected = await engine.consume({ applications: [{ policy: 'user-minute', subject: 'u1' }], context: {} });
    expect(rejected.decision.kind).toBe('rejected');
    expect(rejected.decision.violated?.[0]?.remaining).toBe(0);
  });

  it('rejects cost greater than the remaining amount', async () => {
    const { engine } = buildEngine();
    await engine.consume({ applications: [{ policy: 'user-minute', subject: 'u1' }], context: {} }); // used 1/3
    const result = await engine.consume({
      applications: [{ policy: 'user-minute', subject: 'u1', cost: 5 }],
      context: {},
    });
    expect(result.decision.kind).toBe('rejected');
  });

  it('rejects cost greater than the entire limit even from zero usage', async () => {
    const { engine } = buildEngine();
    const result = await engine.consume({
      applications: [{ policy: 'user-minute', subject: 'fresh', cost: 100 }],
      context: {},
    });
    expect(result.decision.kind).toBe('rejected');
  });

  it('rejects invalid cost values (zero, negative, NaN, Infinity, non-integer)', async () => {
    const { engine } = buildEngine();
    for (const cost of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      await expect(
        engine.consume({ applications: [{ policy: 'user-minute', subject: 'u1', cost }], context: {} }),
      ).rejects.toThrow(InvalidQuotaCostError);
    }
  });

  it('consumes multiple policies atomically: all-or-nothing', async () => {
    const { engine, store, clock } = buildEngine();
    // Exhaust the tenant-day bucket first.
    await engine.consume({ applications: [{ policy: 'tenant-day', subject: 't1', cost: 5 }], context: {} });

    const before = await engine.getUsage('user-minute', 'u1');
    const result = await engine.consume({
      applications: [
        { policy: 'user-minute', subject: 'u1' },
        { policy: 'tenant-day', subject: 't1' }, // this one is exhausted
      ],
      context: {},
    });
    expect(result.decision.kind).toBe('rejected');
    const after = await engine.getUsage('user-minute', 'u1');
    // user-minute must NOT have been partially consumed even though it alone would have been allowed
    expect(after.used).toBe(before.used);
    void store;
    void clock;
  });

  it('respects window reset', async () => {
    const { engine, clock } = buildEngine();
    for (let i = 0; i < 3; i++) {
      await engine.consume({ applications: [{ policy: 'user-minute', subject: 'u1' }], context: {} });
    }
    const rejected = await engine.consume({ applications: [{ policy: 'user-minute', subject: 'u1' }], context: {} });
    expect(rejected.decision.kind).toBe('rejected');

    clock.advance(60_000); // next minute window
    const allowed = await engine.consume({ applications: [{ policy: 'user-minute', subject: 'u1' }], context: {} });
    expect(allowed.decision.kind).toBe('allowed');
  });

  it('handles zero-limit quotas by always rejecting', async () => {
    const clock = new FakeClock(0);
    const store = new MemoryQuotaStore({ clock });
    const engine = new QuotaEngine({ store, clock }, [
      { name: 'blocked', scope: 'tenant', window: { type: 'fixed', unit: 'day' }, limit: 0 },
    ]);
    const result = await engine.consume({ applications: [{ policy: 'blocked', subject: 't1' }], context: {} });
    expect(result.decision.kind).toBe('rejected');
  });
});

describe('QuotaEngine idempotency', () => {
  it('does not double-charge a retried request with the same idempotency key', async () => {
    const { engine } = buildEngine();
    const first = await engine.consume({
      applications: [{ policy: 'user-minute', subject: 'u1' }],
      context: {},
      idempotencyKey: 'req-1',
    });
    const second = await engine.consume({
      applications: [{ policy: 'user-minute', subject: 'u1' }],
      context: {},
      idempotencyKey: 'req-1',
    });
    expect(first.decision.statuses[0]?.used).toBe(1);
    expect(second.decision.statuses[0]?.used).toBe(1);
  });

  it('throws IdempotencyConflictError when the same key is reused with a different amount', async () => {
    const { engine } = buildEngine();
    await engine.consume({
      applications: [{ policy: 'user-minute', subject: 'u1' }],
      context: {},
      idempotencyKey: 'req-2',
    });
    await expect(
      engine.consume({
        applications: [{ policy: 'user-minute', subject: 'u1', cost: 2 }],
        context: {},
        idempotencyKey: 'req-2',
      }),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('throws IdempotencyConflictError when the same key is reused with a different policy', async () => {
    const { engine } = buildEngine();
    await engine.consume({
      applications: [{ policy: 'user-minute', subject: 'u1' }],
      context: {},
      idempotencyKey: 'req-3',
    });
    await expect(
      engine.consume({
        applications: [{ policy: 'tenant-day', subject: 'u1' }],
        context: {},
        idempotencyKey: 'req-3',
      }),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('allows key reuse after expiration', async () => {
    const clock = new FakeClock(0);
    const store = new MemoryQuotaStore({ clock });
    const engine = new QuotaEngine({ store, clock, idempotencyTtlMs: 1000 }, [
      { name: 'p', scope: 'tenant', window: { type: 'fixed', unit: 'day' }, limit: 10 },
    ]);
    await engine.consume({ applications: [{ policy: 'p', subject: 't1' }], context: {}, idempotencyKey: 'k' });
    clock.advance(2000);
    // different amount, but key has expired so this is treated as a fresh call, not a conflict
    const result = await engine.consume({
      applications: [{ policy: 'p', subject: 't1', cost: 3 }],
      context: {},
      idempotencyKey: 'k',
    });
    expect(result.decision.kind).toBe('allowed');
    expect(result.decision.statuses[0]?.used).toBe(4);
  });
});

describe('QuotaEngine reservations', () => {
  it('supports the full reserve -> commit lifecycle', async () => {
    const { engine } = buildEngine();
    const { handle } = await engine.reserve({ policy: 'user-minute', subject: 'u1' }, {});
    const usageDuringHold = await engine.getUsage('user-minute', 'u1');
    expect(usageDuringHold.used).toBe(1); // capacity held immediately

    const status = await engine.commitReservation(handle.id);
    expect(status.used).toBe(1);
  });

  it('supports reserve -> release, returning capacity', async () => {
    const { engine } = buildEngine();
    const { handle } = await engine.reserve({ policy: 'user-minute', subject: 'u1' }, {});
    await engine.releaseReservation(handle.id);
    const usage = await engine.getUsage('user-minute', 'u1');
    expect(usage.used).toBe(0);
  });

  it('expires an abandoned reservation so it does not permanently lock quota', async () => {
    const { engine, clock } = buildEngine();
    const { handle } = await engine.reserve({ policy: 'user-minute', subject: 'u1' }, {}, 1000);
    clock.advance(2000);
    await expect(engine.commitReservation(handle.id)).rejects.toThrow();
    const usage = await engine.getUsage('user-minute', 'u1');
    expect(usage.used).toBe(0); // released lazily on the failed commit attempt
  });
});

describe('QuotaEngine failure modes', () => {
  function unavailableStore(): QuotaStore {
    return {
      check: vi.fn().mockRejectedValue(new Error('boom')),
      checkAndConsume: vi.fn().mockRejectedValue(new Error('boom')),
      getUsage: vi.fn().mockRejectedValue(new Error('boom')),
      recordUsage: vi.fn().mockRejectedValue(new Error('boom')),
      reserve: vi.fn().mockRejectedValue(new Error('boom')),
      commitReservation: vi.fn().mockRejectedValue(new Error('boom')),
      releaseReservation: vi.fn().mockRejectedValue(new Error('boom')),
    };
  }

  it('fail-closed rejects with QuotaStoreError, not QuotaExceededError, when the store is unavailable', async () => {
    const { engine } = buildEngine({ failureMode: 'closed', store: unavailableStore() });
    await expect(
      engine.consume({ applications: [{ policy: 'user-minute', subject: 'u1' }], context: {} }),
    ).rejects.toThrow(QuotaStoreError);
  });

  it('fail-open allows the request through when the store is unavailable', async () => {
    const { engine } = buildEngine({ failureMode: 'open', store: unavailableStore() });
    const result = await engine.consume({ applications: [{ policy: 'user-minute', subject: 'u1' }], context: {} });
    expect(result.decision.kind).toBe('allowed');
    expect(result.degraded).toBe(true);
  });
});

describe('QuotaEngine.consumeOrThrow', () => {
  it('throws QuotaExceededError with useful metadata', async () => {
    const { engine } = buildEngine();
    for (let i = 0; i < 3; i++) {
      await engine.consume({ applications: [{ policy: 'user-minute', subject: 'u1' }], context: {} });
    }
    let caught: unknown;
    try {
      await engine.consumeOrThrow({ applications: [{ policy: 'user-minute', subject: 'u1' }], context: {} });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QuotaExceededError);
    expect((caught as QuotaExceededError).errorCode).toBe('QUOTA_EXCEEDED');
    expect((caught as QuotaExceededError).details.remaining).toBe(0);
  });
});

describe('QuotaEngine.recordUsage', () => {
  it('clamps recorded usage at the limit rather than going negative or over', async () => {
    const { engine } = buildEngine();
    const [status] = await engine.recordUsage({
      applications: [{ policy: 'user-minute', subject: 'u1', cost: 100 }],
      context: {},
    });
    expect(status?.used).toBe(3); // clamped at limit
    expect(status?.remaining).toBe(0);
  });
});

describe('policy registration', () => {
  it('rejects registering the same policy name twice', () => {
    const clock = new FakeClock(0);
    const store = new MemoryQuotaStore({ clock });
    expect(
      () =>
        new QuotaEngine({ store, clock }, [
          { name: 'dup', scope: 'tenant', window: { type: 'fixed', unit: 'day' }, limit: 1 },
          { name: 'dup', scope: 'tenant', window: { type: 'fixed', unit: 'day' }, limit: 2 },
        ]),
    ).toThrow();
  });

  it('rejects referencing an unknown policy', async () => {
    const { engine } = buildEngine();
    await expect(
      engine.consume({ applications: [{ policy: 'does-not-exist', subject: 'u1' }], context: {} }),
    ).rejects.toThrow();
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});
