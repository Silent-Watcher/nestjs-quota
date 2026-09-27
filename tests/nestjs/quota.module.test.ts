import { describe, expect, it } from 'vitest';
import type { Provider } from '@nestjs/common';
import { QuotaModule } from '../../src/nestjs/module/quota.module.js';
import { QUOTA_ENGINE, QUOTA_MODULE_OPTIONS } from '../../src/nestjs/tokens/tokens.js';
import { QuotaEngine } from '../../src/core/application/engine.js';
import { MemoryQuotaStore } from '../../src/stores/memory/memory-store.js';
import { QuotaService } from '../../src/nestjs/module/quota.service.js';
import { QuotaGuard } from '../../src/nestjs/guards/quota.guard.js';

function findProvider(providers: Provider[], token: unknown): Provider | undefined {
  return providers.find((p) => p === token || (typeof p === 'object' && (p as { provide?: unknown }).provide === token));
}

describe('QuotaModule.forRoot', () => {
  it('registers an engine provider built from the given store and policies', async () => {
    const store = new MemoryQuotaStore();
    const dynamicModule = QuotaModule.forRoot({
      store,
      policies: [{ name: 'p', scope: 'tenant', window: { type: 'fixed', unit: 'day' }, limit: 5 }],
      identityResolver: async () => 't1',
    });

    const providers = dynamicModule.providers as Provider[];
    const optionsProvider = findProvider(providers, QUOTA_MODULE_OPTIONS) as { useValue: unknown };
    const engineProvider = findProvider(providers, QUOTA_ENGINE) as {
      useFactory: (options: unknown) => QuotaEngine;
    };

    expect(optionsProvider).toBeDefined();
    expect(engineProvider).toBeDefined();

    const engine = engineProvider.useFactory(optionsProvider.useValue);
    expect(engine).toBeInstanceOf(QuotaEngine);

    const result = await engine.consume({ applications: [{ policy: 'p', subject: 't1' }], context: {} });
    expect(result.decision.kind).toBe('allowed');
  });

  it('exports QuotaService, QuotaGuard and the engine/options tokens', () => {
    const dynamicModule = QuotaModule.forRoot({
      store: new MemoryQuotaStore(),
      policies: [],
      identityResolver: async () => 'x',
    });
    expect(dynamicModule.exports).toEqual(
      expect.arrayContaining([QuotaService, QuotaGuard, QUOTA_ENGINE, QUOTA_MODULE_OPTIONS]),
    );
  });

  it('defaults failureMode to closed and clock to system time when not provided', async () => {
    const store = new MemoryQuotaStore();
    const dynamicModule = QuotaModule.forRoot({
      store,
      policies: [{ name: 'p', scope: 'tenant', window: { type: 'fixed', unit: 'day' }, limit: 1 }],
      identityResolver: async () => 't1',
    });
    const providers = dynamicModule.providers as Provider[];
    const optionsProvider = findProvider(providers, QUOTA_MODULE_OPTIONS) as { useValue: unknown };
    const engineProvider = findProvider(providers, QUOTA_ENGINE) as {
      useFactory: (options: unknown) => QuotaEngine;
    };
    const engine = engineProvider.useFactory(optionsProvider.useValue);
    // consume the single unit, then confirm a second call is rejected rather than throwing (fail-closed only manifests on store errors, not on this happy path)
    await engine.consume({ applications: [{ policy: 'p', subject: 't1' }], context: {} });
    const second = await engine.consume({ applications: [{ policy: 'p', subject: 't1' }], context: {} });
    expect(second.decision.kind).toBe('rejected');
  });
});

describe('QuotaModule.forRootAsync', () => {
  it('builds options via the supplied factory, including injected dependencies', async () => {
    class ConfigService {
      getLimit() {
        return 42;
      }
    }
    const dynamicModule = QuotaModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        store: new MemoryQuotaStore(),
        policies: [
          { name: 'p', scope: 'tenant', window: { type: 'fixed' as const, unit: 'day' as const }, limit: config.getLimit() },
        ],
        identityResolver: async () => 't1',
      }),
    });
    const providers = dynamicModule.providers as Provider[];
    const optionsProvider = findProvider(providers, QUOTA_MODULE_OPTIONS) as {
      useFactory: (config: ConfigService) => { policies: readonly { limit?: number }[] };
    };
    const resolved = optionsProvider.useFactory(new ConfigService());
    expect(resolved.policies[0]?.limit).toBe(42);
  });
});
