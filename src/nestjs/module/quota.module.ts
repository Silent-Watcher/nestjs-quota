import { DynamicModule, Module, Provider } from '@nestjs/common';
import { QuotaEngine } from '../../core/application/engine.js';
import { SystemClock } from '../../core/contracts/clock.js';
import { QUOTA_ENGINE, QUOTA_MODULE_OPTIONS } from '../tokens/tokens.js';
import { QuotaService } from './quota.service.js';
import { QuotaGuard } from '../guards/quota.guard.js';
import { QuotaMeterInterceptor } from '../interceptors/quota-meter.interceptor.js';
import type { QuotaModuleAsyncOptions, QuotaModuleOptions } from './quota-module-options.js';

function buildEngineProvider(): Provider {
  return {
    provide: QUOTA_ENGINE,
    useFactory: (options: QuotaModuleOptions) =>
      new QuotaEngine(
        {
          store: options.store,
          clock: options.clock ?? new SystemClock(),
          failureMode: options.failureMode ?? 'closed',
          hooks: options.hooks,
        },
        options.policies,
      ),
    inject: [QUOTA_MODULE_OPTIONS],
  };
}

/**
 * NestJS dynamic module. Does not register `QuotaGuard` globally — apply it
 * per-controller/route with `@UseGuards(QuotaGuard)` unless you explicitly
 * want a single global guard (registering it both globally and locally is
 * safe against double-charging, see docs/design.md, but still wasteful).
 */
@Module({})
export class QuotaModule {
  static forRoot<TContext = unknown>(options: QuotaModuleOptions<TContext>): DynamicModule {
    const optionsProvider: Provider = { provide: QUOTA_MODULE_OPTIONS, useValue: options };
    return {
      module: QuotaModule,
      providers: [optionsProvider, buildEngineProvider(), QuotaService, QuotaGuard, QuotaMeterInterceptor],
      exports: [QuotaService, QuotaGuard, QuotaMeterInterceptor, QUOTA_ENGINE, QUOTA_MODULE_OPTIONS],
    };
  }

  static forRootAsync<TContext = unknown>(options: QuotaModuleAsyncOptions<TContext>): DynamicModule {
    const optionsProvider: Provider = {
      provide: QUOTA_MODULE_OPTIONS,
      useFactory: options.useFactory,
      inject: options.inject ?? [],
    };
    return {
      module: QuotaModule,
      imports: options.imports ?? [],
      providers: [optionsProvider, buildEngineProvider(), QuotaService, QuotaGuard, QuotaMeterInterceptor],
      exports: [QuotaService, QuotaGuard, QuotaMeterInterceptor, QUOTA_ENGINE, QUOTA_MODULE_OPTIONS],
    };
  }
}
