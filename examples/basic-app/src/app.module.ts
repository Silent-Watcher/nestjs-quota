import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { QuotaModule } from 'nestjs-quota/nestjs';
import { MemoryQuotaStore } from 'nestjs-quota';
import { RedisQuotaStore } from 'nestjs-quota/redis';
import Redis from 'ioredis';
import type { Request } from 'express';
import { FakeAuthMiddleware, type AuthContext } from './fake-auth.middleware.js';
import { WidgetsController } from './widgets.controller.js';

const PLAN_MINUTE_LIMITS: Record<AuthContext['plan'], number> = {
  free: 10,
  pro: 100,
};

function buildStore() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return new MemoryQuotaStore();
  const client = new Redis(redisUrl);
  return new RedisQuotaStore({ client, namespace: 'nest-quota-example' });
}

@Module({
  imports: [
    // The engine's `context` type is always "whatever object the guard
    // passes through" -- in the NestJS integration that's the framework's
    // request object itself (see `QuotaGuard`), so `limitResolver` and
    // `identityResolver` both receive it, not an arbitrary domain type.
    // Here that's an Express `Request` augmented with `.auth` by
    // `FakeAuthMiddleware`.
    QuotaModule.forRoot<Request>({
      store: buildStore(),
      failureMode: 'closed',
      policies: [
        {
          // Per-user, per-minute limit, resolved dynamically from the tenant's plan.
          name: 'user-minute',
          scope: 'user',
          window: { type: 'fixed', unit: 'minute' },
          limitResolver: (req) => PLAN_MINUTE_LIMITS[req.auth?.plan ?? 'free'],
        },
        {
          // Tenant-wide daily ceiling, enforced together with user-minute on the same route.
          name: 'tenant-day',
          scope: 'tenant',
          window: { type: 'fixed', unit: 'day' },
          limit: 5_000,
        },
      ],
      // Identity is resolved from `req.auth`, populated by FakeAuthMiddleware
      // *before* the guard runs -- never from a raw, unauthenticated header
      // read directly here. See the root README's "Security considerations".
      identityResolver: async (ctx) => {
        const req = ctx.raw.switchToHttp().getRequest<Request>();
        if (ctx.policy === 'tenant-day') return req.auth?.tenantId ?? 'unknown-tenant';
        return req.auth?.userId ?? 'unknown-user';
      },
    }),
  ],
  controllers: [WidgetsController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(FakeAuthMiddleware).forRoutes('*');
  }
}
