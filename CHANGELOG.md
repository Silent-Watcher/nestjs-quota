# Changelog

All notable changes to this project are documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/), and
this project adheres to [Semantic Versioning](https://semver.org/).

Behavioral changes are documented here even when they don't change any
TypeScript type signature — see "Migration / versioning policy" in the
README.

## [Unreleased]

## [0.1.0] - Initial release

### Added

- Framework-agnostic core: `QuotaEngine`, `definePolicy`, fixed-window
  resolution (`resolveFixedWindow`), typed error hierarchy, `Clock`
  abstraction (`SystemClock` / `FakeClock`).
- `MemoryQuotaStore`: deterministic, concurrency-safe in-memory
  `QuotaStore` implementation with lazy and optional-interval expiration.
- `RedisQuotaStore`: Redis-backed `QuotaStore` using Lua scripts for
  atomic multi-bucket check-and-consume, reservation lifecycle, and
  clamped post-hoc usage recording. `ioredis` kept as an optional peer
  dependency via a structural `RedisLikeClient` interface.
- NestJS integration (`nestjs-quota/nestjs`): `QuotaModule`
  (`forRoot`/`forRootAsync`), `QuotaService`, `QuotaGuard`,
  `QuotaMeterInterceptor`, `@Quota()`, `@SkipQuota()`, `@MeterUsage()`.
- Idempotent consumption (`idempotencyKey`), with conflict detection on
  reuse with a different request shape.
- Reserve/commit/release semantics with lease-based expiration.
- Configurable `failureMode` (`'open' | 'closed'`), with `QuotaExceededError`
  (429) always distinguished from `QuotaStoreError` (503) in the NestJS
  guard.
- Observability hooks (`QuotaEngineHooks`) with no dependency on any
  specific telemetry library.
- Clean subpath exports: `nestjs-quota`, `nestjs-quota/nestjs`,
  `nestjs-quota/redis`. ESM + CJS + type declarations via `tsup`.
