/**
 * These tests exercise `RedisQuotaStore` against a real Redis server,
 * because `ioredis-mock`-style fakes do not implement a real Lua
 * interpreter and would not actually prove the atomicity guarantees this
 * store depends on. Set `REDIS_URL` (e.g. `redis://localhost:6379`) to run
 * them; otherwise the whole suite is skipped.
 *
 * CI runs these against a `redis:7` service container (see
 * `.github/workflows/ci.yml`). Locally: `docker run --rm -p 6379:6379 redis:7`.
 */
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RedisQuotaStore } from '../../src/stores/redis/redis-store.js';
import { QuotaEngine } from '../../src/core/application/engine.js';
import { FakeClock } from '../../src/core/contracts/clock.js';
import { IdempotencyConflictError } from '../../src/core/errors/errors.js';

const REDIS_URL = process.env.REDIS_URL;
const describeIfRedis = REDIS_URL ? describe : describe.skip;

describeIfRedis('RedisQuotaStore (integration, real Redis)', () => {
  let client: Redis;

  beforeAll(() => {
    client = new Redis(REDIS_URL as string, { lazyConnect: true });
  });

  afterAll(async () => {
    await client.quit();
  });

  afterEach(async () => {
    // Namespace is unique per test (random suffix), so a full flush is
    // unnecessary, but keep the keyspace tidy between runs.
    const keys = await client.keys('quota-test-*');
    if (keys.length > 0) await client.del(...keys);
  });

  function buildEngine(namespace: string) {
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const store = new RedisQuotaStore({ client, clock, namespace });
    const engine = new QuotaEngine({ store, clock }, [
      { name: 'user-minute', scope: 'user', window: { type: 'fixed', unit: 'minute' }, limit: 3 },
      { name: 'tenant-day', scope: 'tenant', window: { type: 'fixed', unit: 'day' }, limit: 5 },
    ]);
    return { engine, clock };
  }

  it('connects successfully', async () => {
    await client.connect();
    expect(client.status).toBe('ready');
  });

  it('allows below the limit and rejects once exhausted', async () => {
    const { engine } = buildEngine(`quota-test-${Date.now()}-a`);
    for (let i = 0; i < 3; i++) {
      const r = await engine.consume({ applications: [{ policy: 'user-minute', subject: 'u1' }], context: {} });
      expect(r.decision.kind).toBe('allowed');
    }
    const rejected = await engine.consume({ applications: [{ policy: 'user-minute', subject: 'u1' }], context: {} });
    expect(rejected.decision.kind).toBe('rejected');
  });

  it('proves atomic multi-bucket consumption: no naive race leaves a partial charge', async () => {
    const { engine } = buildEngine(`quota-test-${Date.now()}-b`);
    await engine.consume({ applications: [{ policy: 'tenant-day', subject: 't1', cost: 5 }], context: {} });
    const before = await engine.getUsage('user-minute', 'u1');
    const result = await engine.consume({
      applications: [
        { policy: 'user-minute', subject: 'u1' },
        { policy: 'tenant-day', subject: 't1' },
      ],
      context: {},
    });
    expect(result.decision.kind).toBe('rejected');
    const after = await engine.getUsage('user-minute', 'u1');
    expect(after.used).toBe(before.used);
  });

  it('handles concurrent requests without over-consuming (real Redis, real network round-trips)', async () => {
    const { engine } = buildEngine(`quota-test-${Date.now()}-c`);
    const attempts = Array.from({ length: 50 }, () =>
      engine.consume({ applications: [{ policy: 'tenant-day', subject: 'concurrent' }], context: {} }),
    );
    const results = await Promise.all(attempts);
    const allowedCount = results.filter((r) => r.decision.kind === 'allowed').length;
    expect(allowedCount).toBe(5);
  });

  it('supports idempotent retries and rejects conflicting reuse', async () => {
    const { engine } = buildEngine(`quota-test-${Date.now()}-d`);
    const first = await engine.consume({
      applications: [{ policy: 'user-minute', subject: 'u1' }],
      context: {},
      idempotencyKey: 'k1',
    });
    const second = await engine.consume({
      applications: [{ policy: 'user-minute', subject: 'u1' }],
      context: {},
      idempotencyKey: 'k1',
    });
    expect(first.decision.statuses[0]?.used).toBe(1);
    expect(second.decision.statuses[0]?.used).toBe(1);

    await expect(
      engine.consume({
        applications: [{ policy: 'user-minute', subject: 'u1', cost: 2 }],
        context: {},
        idempotencyKey: 'k1',
      }),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('supports the reserve -> commit -> getUsage lifecycle', async () => {
    const { engine } = buildEngine(`quota-test-${Date.now()}-e`);
    const { handle } = await engine.reserve({ policy: 'user-minute', subject: 'u1' }, {});
    const held = await engine.getUsage('user-minute', 'u1');
    expect(held.used).toBe(1);
    await engine.commitReservation(handle.id);
    const after = await engine.getUsage('user-minute', 'u1');
    expect(after.used).toBe(1);
  });

  it('supports reserve -> release, returning capacity', async () => {
    const { engine } = buildEngine(`quota-test-${Date.now()}-f`);
    const { handle } = await engine.reserve({ policy: 'user-minute', subject: 'u1' }, {});
    await engine.releaseReservation(handle.id);
    const usage = await engine.getUsage('user-minute', 'u1');
    expect(usage.used).toBe(0);
  });

  it('sets a TTL on newly created bucket keys so they expire with the window', async () => {
    const namespace = `quota-test-${Date.now()}-g`;
    const { engine } = buildEngine(namespace);
    await engine.consume({ applications: [{ policy: 'user-minute', subject: 'u1' }], context: {} });
    const keys = await client.keys(`${namespace}:quota:*`);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const ttl = await client.pttl(key);
      expect(ttl).toBeGreaterThan(0);
    }
  });
});
