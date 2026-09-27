import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { QuotaGuard } from '../../src/nestjs/guards/quota.guard.js';
import { QUOTA_METADATA_KEY, SKIP_QUOTA_METADATA_KEY } from '../../src/nestjs/tokens/tokens.js';
import { QuotaEngine } from '../../src/core/application/engine.js';
import { FakeClock } from '../../src/core/contracts/clock.js';
import { MemoryQuotaStore } from '../../src/stores/memory/memory-store.js';
import { QUOTA_REQUEST_STATE, type QuotaCarryingRequest } from '../../src/nestjs/context/request-marker.js';
import type { QuotaModuleOptions } from '../../src/nestjs/module/quota-module-options.js';
import type { QuotaRouteOptions } from '../../src/nestjs/decorators/quota.decorator.js';

/** Minimal fake Reflector: reads metadata previously stashed via `stashMetadata`. */
function fakeReflector(metadata: {
  quota?: QuotaRouteOptions;
  skip?: boolean;
}) {
  return {
    getAllAndOverride: (key: symbol) => {
      if (key === QUOTA_METADATA_KEY) return metadata.quota;
      if (key === SKIP_QUOTA_METADATA_KEY) return metadata.skip;
      return undefined;
    },
    get: () => undefined,
  } as unknown as import('@nestjs/core').Reflector;
}

function fakeContext(request: QuotaCarryingRequest, response: { headers: Record<string, string> }): ExecutionContext {
  return {
    getHandler: () => (() => undefined) as never,
    getClass: () => (class {} as never),
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({
        setHeader: (name: string, value: string) => {
          response.headers[name] = value;
        },
      }),
    }),
  } as unknown as ExecutionContext;
}

function buildEngine() {
  const clock = new FakeClock(0);
  const store = new MemoryQuotaStore({ clock });
  return new QuotaEngine(
    { store, clock, failureMode: 'closed' },
    [{ name: 'user-minute', scope: 'user', window: { type: 'fixed', unit: 'minute' }, limit: 2 }],
  );
}

function buildOptions(overrides: Partial<QuotaModuleOptions> = {}): QuotaModuleOptions {
  return {
    store: new MemoryQuotaStore(),
    policies: [],
    identityResolver: async () => 'u1',
    ...overrides,
  };
}

describe('QuotaGuard', () => {
  it('allows a route with no @Quota() metadata', async () => {
    const engine = buildEngine();
    const guard = new QuotaGuard(fakeReflector({}), engine, buildOptions());
    const req: QuotaCarryingRequest = {};
    const res = { headers: {} };
    await expect(guard.canActivate(fakeContext(req, res))).resolves.toBe(true);
  });

  it('allows a route marked @SkipQuota() even with @Quota() metadata present', async () => {
    const engine = buildEngine();
    const guard = new QuotaGuard(
      fakeReflector({ skip: true, quota: { policies: ['user-minute'] } }),
      engine,
      buildOptions(),
    );
    await expect(guard.canActivate(fakeContext({}, { headers: {} }))).resolves.toBe(true);
  });

  it('consumes quota and attaches headers on an allowed request', async () => {
    const engine = buildEngine();
    const guard = new QuotaGuard(
      fakeReflector({ quota: { policies: ['user-minute'] } }),
      engine,
      buildOptions(),
    );
    const req: QuotaCarryingRequest = {};
    const res = { headers: {} };
    await expect(guard.canActivate(fakeContext(req, res))).resolves.toBe(true);
    expect(req[QUOTA_REQUEST_STATE]?.handled).toBe(true);
    expect(res.headers['X-RateLimit-Limit']).toBe('2');
    expect(res.headers['X-RateLimit-Remaining']).toBe('1');
  });

  it('throws a 429 HttpException when quota is exceeded', async () => {
    const engine = buildEngine();
    const options = buildOptions();
    const guard = new QuotaGuard(fakeReflector({ quota: { policies: ['user-minute'] } }), engine, options);
    // exhaust the quota
    await engine.consume({ applications: [{ policy: 'user-minute', subject: 'u1' }], context: {} });
    await engine.consume({ applications: [{ policy: 'user-minute', subject: 'u1' }], context: {} });

    let caught: unknown;
    try {
      await guard.canActivate(fakeContext({}, { headers: {} }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { getStatus?: () => number }).getStatus?.() ?? 429).toBeDefined();
  });

  it('does not double-charge when a second guard instance sees an already-handled request', async () => {
    const engine = buildEngine();
    const options = buildOptions();
    const guardA = new QuotaGuard(fakeReflector({ quota: { policies: ['user-minute'] } }), engine, options);
    const guardB = new QuotaGuard(fakeReflector({ quota: { policies: ['user-minute'] } }), engine, options);
    const req: QuotaCarryingRequest = {};
    const res = { headers: {} };
    const ctx = fakeContext(req, res);

    await guardA.canActivate(ctx);
    await guardB.canActivate(ctx);

    const usage = await engine.getUsage('user-minute', 'u1');
    expect(usage.used).toBe(1); // only charged once despite two guards running
  });

  it('resolves per-application cost via the module-level costResolver', async () => {
    const engine = buildEngine();
    const options = buildOptions({ costResolver: async () => 2 });
    const guard = new QuotaGuard(fakeReflector({ quota: { policies: ['user-minute'] } }), engine, options);
    const req: QuotaCarryingRequest = {};
    await guard.canActivate(fakeContext(req, { headers: {} }));
    const usage = await engine.getUsage('user-minute', 'u1');
    expect(usage.used).toBe(2);
  });
});
