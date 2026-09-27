# Contributing

Thanks for considering a contribution to `nestjs-quota`.

## Getting started

```bash
git clone <repo-url>
cd nest-quota
npm install
npm run build
npm test
```

Redis-backed integration tests are skipped automatically unless `REDIS_URL`
is set:

```bash
docker run --rm -p 6379:6379 redis:7
REDIS_URL=redis://localhost:6379 npm run test:integration
```

## Project layout

```text
src/
├── core/       framework-agnostic domain, engine, policies, windows, errors
├── nestjs/     NestJS module, guard, interceptor, decorators
└── stores/
    ├── memory/ in-memory QuotaStore
    └── redis/  Redis QuotaStore + Lua scripts
tests/
├── unit/         core logic, no I/O
├── adapter/      store implementations in isolation
├── concurrency/  deterministic Promise.all races
├── nestjs/       guard/module/decorator/interceptor, no HTTP server
└── integration/  real NestJS app + supertest, real Redis when available
docs/design.md    the "why" behind every non-obvious decision
```

Read [`docs/design.md`](./docs/design.md) before changing behavior in
`core/` — many things that look like arbitrary choices (window boundary
semantics, key format, failure-mode mapping) are deliberate and documented
there. If you're proposing a behavioral change, update that document in the
same PR.

## Architectural rules (enforced by review, not currently by lint)

- `src/core/**` must never import `@nestjs/*`, `ioredis`, or any
  HTTP-specific API.
- `src/stores/redis/**` must never assume a specific application framework.
- All time access goes through the `Clock` interface — no direct
  `Date.now()` / `new Date()` in decision-making code paths.
- Multi-bucket store operations must remain atomic (see
  [`docs/design.md §2`](./docs/design.md#2-atomic-multi-policy-consumption)).
  Any change to `checkAndConsume` in either store needs a concurrency test
  proving it (see `tests/concurrency/`).

## Making changes

1. **Write the failing test first** where practical, especially for
   anything touching atomicity, idempotency, or reservation lifecycle.
2. Run the full suite locally: `npm test && npm run test:concurrency`.
   Run `npm run test:integration` too if you touched the Redis store or
   the NestJS module wiring.
3. `npm run typecheck && npm run lint && npm run format:check`.
4. Update `docs/design.md` if you changed a documented decision; update
   `README.md` if you changed public API or behavior visible to consumers.
5. Add a `CHANGELOG.md` entry under `[Unreleased]`.

## Commit / PR conventions

- Keep PRs focused on one change. Large refactors are easier to review
  split by layer (core → memory store → Redis store → NestJS).
- Describe *behavioral* changes explicitly in the PR description, even if
  the TypeScript signatures didn't change — this project treats behavioral
  changes as breaking regardless of type-level compatibility (see
  "Migration / versioning policy" in the README).

## Adding a new storage backend

Implement `QuotaStore` (`src/core/contracts/store.ts`). At minimum:

- `checkAndConsume` must be atomic across the whole batch — no partial
  application under concurrent callers.
- Bucket keys should use `buildBucketKey` (or an equivalent
  namespaced/bounded/hashed scheme) rather than ad hoc string
  concatenation.
- Add adapter tests mirroring `tests/adapter/memory-store.test.ts` and
  concurrency tests mirroring `tests/concurrency/concurrent-consumption.test.ts`.
- Document the new store's setup in the README under "Redis setup" (add a
  parallel section) and note it as an option in `docs/design.md` if it
  introduces any new tradeoff.

## Code style

- TypeScript strict mode; no `any`, no `@ts-ignore`, no unsafe casts
  without a comment explaining why.
- Prefer small, composable functions over large ones with many branches.
- Prettier formats everything; don't hand-format around it.

## Reporting bugs / requesting features

Open a GitHub issue. For security vulnerabilities, see
[`SECURITY.md`](./SECURITY.md) instead — do not open a public issue.
