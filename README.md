# nestjs-quota

Production-grade **API quota enforcement** and **usage metering** for
NestJS: multi-scope policies, atomic distributed consumption, idempotent
retries, hold/commit/release reservations, and pluggable storage
(in-memory for dev/tests, Redis for production) — without an ORM, without
a mandatory database, and without coupling your domain logic to NestJS or
Redis.

## Why this exists

Rate limiting middleware answers one question: *"is this client sending
requests too fast?"* That's not the same problem as **quota enforcement**
and **usage metering**, which need to answer:

- "Has this tenant used up their monthly API allowance?"
- "How many requests does this user have left this minute, *and* how many
  does their tenant have left today, *and* this month — all three, for one
  request?"
- "If two servers both try to consume the last unit of quota at the same
  instant, does exactly one succeed?"
- "If the client retries a request after a timeout, do we charge them
  twice?"
- "Can we hold capacity for an in-flight LLM call before we know its real
  token cost, then reconcile afterwards?"

That's what this package does. It is not a generic "everything platform" —
no ORM, no mandatory database, no bundled billing integration. It is a
focused quota/metering engine with a first-class NestJS integration.

## What problem it solves

```text
Free plan:      10,000 requests / month
Pro plan:    1,000,000 requests / month

Additional constraints, evaluated together on every request:
  100 requests / minute / user
  10,000 requests / day / tenant
  1,000,000 requests / month / tenant
```

A single request can be checked against all of these at once, atomically —
either every quota bucket is consumed, or none is.

## Installation

```bash
npm install nestjs-quota
# NestJS integration:
npm install @nestjs/common @nestjs/core reflect-metadata rxjs
# Optional, for the Redis store:
npm install ioredis
```

`@nestjs/*`, `reflect-metadata`, `rxjs`, and `ioredis` are all optional
peer dependencies — the core package (`nestjs-quota`) has **zero
runtime dependencies** and works standalone in any Node.js codebase.

## Quick start (framework-agnostic core)

```ts
import { QuotaEngine, MemoryQuotaStore } from 'nestjs-quota';

const engine = new QuotaEngine(
  { store: new MemoryQuotaStore() }, // clock defaults to system time
  [
    { name: 'tenant-monthly-api', scope: 'tenant', window: { type: 'fixed', unit: 'month' }, limit: 100_000 },
    { name: 'user-minute', scope: 'user', window: { type: 'fixed', unit: 'minute' }, limit: 100 },
  ],
);

const result = await engine.consume({
  applications: [
    { policy: 'tenant-monthly-api', subject: 'tenant_123' },
    { policy: 'user-minute', subject: 'user_456' },
  ],
  context: {}, // passed to any dynamic limitResolver
});

if (result.decision.kind === 'rejected') {
  // one or more policies would have been exceeded; NEITHER was consumed
  console.log(result.decision.violated);
} else {
  console.log(result.decision.statuses); // [{ policy, limit, used, remaining, resetAt }, ...]
}
```

## NestJS setup

```ts
import { Module } from '@nestjs/common';
import { QuotaModule } from 'nestjs-quota/nestjs';
import { MemoryQuotaStore } from 'nestjs-quota';

@Module({
  imports: [
    QuotaModule.forRoot({
      store: new MemoryQuotaStore(),
      policies: [
        { name: 'user-minute', scope: 'user', window: { type: 'fixed', unit: 'minute' }, limit: 100 },
      ],
      // Never trust raw request data for identity — resolve it from
      // already-authenticated context.
      identityResolver: async (ctx) => {
        const req = ctx.raw.switchToHttp().getRequest();
        return req.user.id;
      },
      failureMode: 'closed', // 'open' lets requests through if the store is unavailable
    }),
  ],
})
export class AppModule {}
```

```ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { Quota, QuotaGuard } from 'nestjs-quota/nestjs';

@Controller('users')
@UseGuards(QuotaGuard)
export class UsersController {
  @Get()
  @Quota('user-minute')
  findAll() {
    /* ... */
  }
}
```

A route with no `@Quota()` metadata is left alone by `QuotaGuard` — it's
opt-in per route (or per controller), not global by default.

## Static quota examples

```ts
{ name: 'blocked-region', scope: 'tenant', window: { type: 'fixed', unit: 'day' }, limit: 0 }
{ name: 'burst-5s', scope: 'ip', window: { type: 'fixed', unit: 'second', size: 5 }, limit: 20 }
```

## Dynamic (plan-based) quotas

```ts
interface AppContext {
  plan: 'free' | 'pro' | 'enterprise';
}

{
  name: 'tenant-monthly-api',
  scope: 'tenant',
  window: { type: 'fixed', unit: 'month' },
  limitResolver: (ctx: AppContext) => {
    switch (ctx.plan) {
      case 'free': return 10_000;
      case 'pro': return 1_000_000;
      case 'enterprise': return Number.MAX_SAFE_INTEGER; // or look up a per-tenant override
    }
  },
}
```

> The library never hard-codes a billing system (Stripe or otherwise) — you
resolve the plan however you already do, and hand back a number.

## Multi-scope quotas

```ts
@Quota({
  policies: ['user-minute', 'tenant-day', 'tenant-month', 'global-minute'],
})
@Get()
findAll() { /* ... */ }
```

All four are checked and consumed **atomically**: if any one would be
exceeded, none of them is charged.

## Usage metering (inspection)

```ts
const status = await quotaService.getUsage('tenant-monthly-api', 'tenant_123');
// { policy: 'tenant-monthly-api', limit: 100_000, used: 48_250, remaining: 51_750, resetAt: Date }
```

### Post-handler metering (cost known only after the handler runs)

```ts
import { MeterUsage } from 'nestjs-quota/nestjs';

@Post('completions')
@MeterUsage<{ usage: { totalTokens: number } }>({
  policy: 'tenant-monthly-tokens',
  amountFromResult: (result) => result.usage.totalTokens,
})
createCompletion() {
  /* call the LLM, return its usage */
}
```

Apply `QuotaMeterInterceptor` (exported by the module) alongside this
decorator to actually record the usage after the handler resolves. This is
metering, not admission control — pair it with a `@Quota()` pre-check if
the operation should also be gated up front.

## Idempotency

```ts
await quotaService.consume({
  applications: [{ policy: 'tenant-monthly-api', subject: 'tenant_123' }],
  context: {},
  idempotencyKey: request.headers['idempotency-key'],
});
```

- Same key, same request shape → replays the original outcome, no double
  charge.
- Same key, *different* request shape (different cost/policy/subject) →
  throws `IdempotencyConflictError`.
- Keys expire after `idempotencyTtlMs` (default 24h).

## Reservations

For operations whose real cost isn't known until they complete (or which
might fail entirely), hold capacity up front and reconcile after:

```ts
const { handle } = await quotaService.reserve({ policy: 'llm-monthly-tokens', subject: 'tenant_123' }, {}, /* leaseMs */ 60_000);
try {
  const result = await runExpensiveOperation();
  await quotaService.commitReservation(handle.id);
} catch (err) {
  await quotaService.releaseReservation(handle.id);
  throw err;
}
```

An abandoned reservation (process crash, no commit/release ever called)
expires at its lease and stops holding capacity — see
[`docs/design.md`](./docs/design.md#4-reservation-semantics) for the exact
lifecycle.

## Redis setup

```ts
import Redis from 'ioredis';
import { RedisQuotaStore } from 'nestjs-quota/redis';

const client = new Redis(process.env.REDIS_URL);

QuotaModule.forRoot({
  store: new RedisQuotaStore({ client, namespace: 'myapp' }),
  policies: [/* ... */],
  identityResolver: /* ... */,
});
```

All multi-bucket and read-modify-write operations run as single Lua
scripts server-side — there is no GET-then-SET race window. See
[`docs/design.md`](./docs/design.md#2-atomic-multi-policy-consumption) and
[`src/stores/redis/lua-scripts.ts`](./src/stores/redis/lua-scripts.ts).

`ioredis` is an optional peer dependency; any client that structurally
matches `RedisLikeClient` (`eval`, `get`, `del`) will work.

## Failure modes

```ts
QuotaModule.forRoot({
  failureMode: 'closed', // default: reject with 503 if the store is unavailable
  // failureMode: 'open', // let requests through (degraded: true) if the store is unavailable
  // ...
});
```

`QuotaExceededError` always maps to **HTTP 429**; any store/infrastructure
failure always maps to **HTTP 503** (in `closed` mode) — these are never
conflated. See [`docs/design.md`](./docs/design.md#7-redis-failure-behavior--fail-open-vs-fail-closed).

## HTTP behavior

On rejection, `QuotaGuard` throws an `HttpException` with:

```json
{
  "error": "QUOTA_EXCEEDED",
  "message": "quota exceeded for policy \"user-minute\"",
  "policy": "user-minute",
  "limit": 100,
  "used": 100,
  "remaining": 0,
  "resetAt": "2026-01-01T00:01:00.000Z",
  "requestedCost": 1
}
```

along with `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset`
and `Retry-After` headers (configurable via `headers: { enabled, prefix }`
on `QuotaModuleOptions`, or disable entirely with `headers: { enabled: false }`).

## Testing

```bash
npm test                # unit + adapter + nestjs projects
npm run test:concurrency
npm run test:integration   # requires REDIS_URL for the Redis suite; full HTTP suite always runs
npm run test:coverage
```

See [Test strategy](#test-strategy) below.

## Architecture

```text
src/
├── core/            framework-agnostic: domain, engine, policies, windows, errors
├── nestjs/          NestJS module, guard, interceptor, decorators
└── stores/
    ├── memory/      in-memory QuotaStore (tests, dev)
    └── redis/       Redis QuotaStore (Lua-script atomic operations)
```

`core` never imports NestJS, Redis, or any HTTP-specific API — see
[`docs/design.md`](./docs/design.md) for the reasoning behind every
non-obvious decision (window semantics, atomicity, idempotency,
reservations, clock handling, plan changes, failure modes, key generation,
HTTP mapping, double-charge prevention).

## Performance considerations

- One logical quota decision across N policies is **one store call**
  (`checkAndConsume`), not N. For Redis, that one call is one round trip
  running one Lua script.
- The in-memory store does no I/O and only synchronous Map operations; its
  cost is dominated by key-string construction.
- Subjects longer than 128 characters are hashed into a fixed-size key
  segment rather than embedded verbatim, bounding key size regardless of
  what identifiers your application produces.
- No benchmark numbers are published here — they depend heavily on your
  Redis topology, network, and policy count. Add `vitest bench` or a
  dedicated `benchmarks/` script if you need numbers for your environment.

## Security considerations

- Identity (`scope`/`subject`) must come from an `identityResolver` you
  control, reading already-authenticated context — never raw,
  unauthenticated request fields. See
  [`docs/design.md §11`](./docs/design.md#11-untrusted-identity).
- All policy/scope/subject components are validated against a strict
  character allow-list and length cap before touching any storage key;
  long subjects are hashed. See
  [`docs/design.md §8`](./docs/design.md#8-key-generation) and
  [§9](./docs/design.md#9-high-cardinality-protection).
- Internal storage errors (Redis error text, stack traces) are never
  included in HTTP responses — only a stable `QUOTA_UNAVAILABLE` code.
- See [`SECURITY.md`](./SECURITY.md) for the vulnerability disclosure
  process.

## FAQ

**Is this a rate limiter?** It can enforce "N per minute" style limits,
but it's built for the broader problem of multi-scope, multi-window quota
accounting with usage metering, idempotency, and reservations — a rate
limiter is a special case of what this does, not the other way around.

**Does it need Redis?** No. The in-memory store is fully functional for a
single-process deployment, local development, and tests. Redis is only
needed once you have multiple processes/servers that must share quota
state.

**Can I use my own storage backend (Postgres, DynamoDB, ...)?**
Yes — implement the `QuotaStore` interface (`src/core/contracts/store.ts`).
The engine and NestJS layer don't know or care what's behind it, as long
as `checkAndConsume` is atomic across the batch.

**What happens if two guards are accidentally registered on the same
route?** The second one sees the request already marked as handled and
does not consume again — see
[`docs/design.md §12`](./docs/design.md#12-avoiding-double-charging).

**How do I do a rolling window instead of fixed?** Not implemented yet —
`WindowSpec` is a discriminated union specifically so this can be added
without breaking existing call sites. Contributions welcome.

## API reference

The full public surface is exported from three entry points:

- `nestjs-quota` — `QuotaEngine`, `MemoryQuotaStore`, policies,
  windows, errors, `Clock`/`FakeClock`/`SystemClock`, identity/key helpers.
- `nestjs-quota/nestjs` — `QuotaModule`, `QuotaService`, `QuotaGuard`,
  `QuotaMeterInterceptor`, `@Quota()`, `@SkipQuota()`, `@MeterUsage()`.
- `nestjs-quota/redis` — `RedisQuotaStore`, `RedisLikeClient`.

Every exported type is documented with TSDoc in its source file; generate
API docs with your preferred TypeDoc setup if you want a static site, or
read the source directly — it's intentionally kept short and readable.

## Limitations

- Only fixed windows are implemented (no rolling/sliding windows yet).
- Reservations are single-policy per call (see
  [`docs/design.md §4`](./docs/design.md#4-reservation-semantics)).
- The Redis store's `check()` (read-only, non-consuming) method is a
  best-effort multi-GET snapshot, not a linearizable read — use
  `checkAndConsume` (or `engine.consume`) whenever the decision must be
  atomic; `check`/`engine.check` is for advisory "would this pass" UIs.
- No built-in support for calendar-defined custom billing periods yet
  (e.g. "billing month starts on the 15th") — `WindowSpec` is designed to
  accommodate this as a future addition.
- Clock skew across application servers is bounded by typical NTP drift;
  see [`docs/design.md §5`](./docs/design.md#5-clock-handling).

## Migration / versioning policy

This package follows [SemVer](https://semver.org/). Any behavioral change
that could alter which requests are allowed/rejected for existing
configurations is treated as a breaking (major) change, even if no
TypeScript type signature changed. See [`CHANGELOG.md`](./CHANGELOG.md).

## Test strategy

| Layer | What it covers | Command |
|---|---|---|
| `tests/unit` | Windows, policies, engine (validation, atomicity, idempotency, reservations, failure modes) | `npm test` |
| `tests/adapter` | `MemoryQuotaStore` in isolation; `RedisQuotaStore` against a real Redis (`REDIS_URL`) | `npm test` / `npm run test:integration` |
| `tests/concurrency` | Deterministic `Promise.all` races: final-unit contention, multi-policy atomicity, concurrent idempotent retries, concurrent reservations, commit/release races | `npm run test:concurrency` |
| `tests/nestjs` | Guard, decorators, module wiring, interceptor — using lightweight fakes, no HTTP server | `npm test` |
| `tests/integration` | A real NestJS app + `supertest`, end to end through HTTP | `npm run test:integration` |

Coverage thresholds (V8 provider): Lines/Functions/Statements ≥ 95%,
Branches ≥ 90%, enforced on `core/` and `stores/memory/` in
`vitest.config.ts`.

## Commands

```bash
npm install
npm run build            # tsup: ESM + CJS + .d.ts for all three entry points
npm run typecheck
npm run lint
npm test
npm run test:coverage
npm pack                 # inspect the tarball before publishing
npm run publish:dry
```

## Future extension points

- Rolling/sliding windows and custom calendar-based billing periods
  (`WindowSpec` union).
- A Postgres/DynamoDB `QuotaStore` reference implementation.
- Multi-policy reservations, if a real use case needs them.
- A benchmark suite (`vitest bench`) with numbers for a specific
  Redis/network topology.
- OpenTelemetry-shaped hook adapters built *on top of* the existing
  framework-agnostic hooks (the core stays free of any specific
  telemetry dependency).
