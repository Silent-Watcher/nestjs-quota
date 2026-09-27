import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import type { ExecutionContext } from '@nestjs/common';
import { QuotaMeterInterceptor, MeterUsage } from '../../src/nestjs/interceptors/quota-meter.interceptor.js';
import { QuotaEngine } from '../../src/core/application/engine.js';
import { MemoryQuotaStore } from '../../src/stores/memory/memory-store.js';
import type { QuotaModuleOptions } from '../../src/nestjs/module/quota-module-options.js';

class LlmController {
  @MeterUsage({ policy: 'tokens', amountFromResult: (r: { tokens: number }) => r.tokens })
  generate() {
    return { tokens: 42 };
  }

  unmetered() {
    return { tokens: 999 };
  }
}

function contextFor(handler: () => unknown): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => LlmController,
    switchToHttp: () => ({ getRequest: () => ({}) }),
  } as unknown as ExecutionContext;
}

function nextReturning(value: unknown) {
  return {
    handle: () =>
      new Observable((observer) => {
        observer.next(value);
        observer.complete();
      }),
  };
}

async function drain(obs: Observable<unknown>): Promise<void> {
  await new Promise<void>((resolve) => {
    obs.subscribe({ complete: () => resolve() } as never);
  });
  // metering is fired inside `tap` without awaiting; give the microtask/timer queue a tick
  await new Promise((r) => setTimeout(r, 0));
}

function buildOptions(): QuotaModuleOptions {
  return { store: new MemoryQuotaStore(), policies: [], identityResolver: async () => 'u1' };
}

describe('QuotaMeterInterceptor', () => {
  it('records the amount derived from the handler result after it resolves', async () => {
    const engine = new QuotaEngine({ store: new MemoryQuotaStore() }, [
      { name: 'tokens', scope: 'user', window: { type: 'fixed', unit: 'day' }, limit: 1000 },
    ]);
    const interceptor = new QuotaMeterInterceptor(new Reflector(), engine, buildOptions());
    const instance = new LlmController();
    await drain(
      interceptor.intercept(contextFor(instance.generate), nextReturning({ tokens: 42 })) as Observable<unknown>,
    );
    const usage = await engine.getUsage('tokens', 'u1');
    expect(usage.used).toBe(42);
  });

  it('does nothing for a handler without @MeterUsage()', async () => {
    const engine = new QuotaEngine({ store: new MemoryQuotaStore() }, [
      { name: 'tokens', scope: 'user', window: { type: 'fixed', unit: 'day' }, limit: 1000 },
    ]);
    const interceptor = new QuotaMeterInterceptor(new Reflector(), engine, buildOptions());
    const instance = new LlmController();
    await drain(
      interceptor.intercept(contextFor(instance.unmetered), nextReturning({ tokens: 999 })) as Observable<unknown>,
    );
    const usage = await engine.getUsage('tokens', 'u1');
    expect(usage.used).toBe(0);
  });

  it('ignores a non-positive or non-finite derived amount rather than throwing', async () => {
    class ZeroController {
      @MeterUsage({ policy: 'tokens', amountFromResult: () => 0 })
      zero() {
        return {};
      }
    }
    const engine = new QuotaEngine({ store: new MemoryQuotaStore() }, [
      { name: 'tokens', scope: 'user', window: { type: 'fixed', unit: 'day' }, limit: 1000 },
    ]);
    const interceptor = new QuotaMeterInterceptor(new Reflector(), engine, buildOptions());
    const instance = new ZeroController();
    const ctx = {
      getHandler: () => instance.zero,
      getClass: () => ZeroController,
      switchToHttp: () => ({ getRequest: () => ({}) }),
    } as unknown as ExecutionContext;
    await drain(interceptor.intercept(ctx, nextReturning({})) as Observable<unknown>);
    const usage = await engine.getUsage('tokens', 'u1');
    expect(usage.used).toBe(0);
  });
});
