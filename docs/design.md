# Design Decisions

This document explains the important, otherwise-implicit decisions behind
`nestjs-quota`. If a behavior surprises you, it's probably documented
here.

## 1. Fixed-window semantics

Windows are `[start, end)` — the end boundary belongs to the *next* window,
never the current one. All window math is done in UTC epoch milliseconds;
there is no local-timezone behavior anywhere in the core. Month windows are
computed from calendar month boundaries (`Date.UTC(year, month, 1)`), so
they correctly handle 28/29/30/31-day months and year rollover without any
special-casing at call sites.

Windows are *anchored to the epoch*, not to "time since first request".
Two independent processes resolving the "current minute window" for the
same wall-clock time always agree on `[start, end)`, without any shared
coordination — this is what makes distributed, multi-process deployments
safe by construction, as long as clocks are reasonably synchronized (see
§5, Clock handling).

Only `fixed` windows are implemented. `WindowSpec` is a discriminated union
specifically so that `rolling`, `calendar` (org-defined billing periods),
and `custom` windows can be added later without changing `QuotaEngine`,
`QuotaStore`, or any call site — they all consume a resolved
`WindowInstance` (`{ startMs, endMs }`), never the spec directly.

## 2. Atomic multi-policy consumption

A single request often needs to satisfy several quotas at once (user/minute
+ tenant/day + tenant/month + global/minute). The engine resolves all of
them into a flat list of `BucketRequest`s and hands the *entire batch* to
`QuotaStore.checkAndConsume` in one call. The contract requires the store to
apply all-or-nothing semantics: either every bucket's usage increments, or
none does.

- **In-memory store**: correctness comes from Node's single-threaded
  execution model. The entire evaluate-then-mutate sequence contains no
  `await`, so no other async task can interleave mid-operation.
- **Redis store**: correctness comes from a single Lua script
  (`checkAndConsume` in `lua-scripts.ts`) that Redis executes as one atomic
  unit against all bucket keys. There is no GET-then-SET race window,
  because there is no round-trip between reading and writing — everything
  happens inside Redis, in one command.

This is why `QuotaStore` doesn't expose a `MULTI`/transaction primitive:
atomicity is the *store's* responsibility to guarantee for the batch, not
something the engine orchestrates from outside (which would require
distributed rollback and could never be made truly atomic over the
network).

## 3. Idempotency semantics

Idempotency is scoped to a single `checkAndConsume` batch, keyed by an
application-supplied `idempotencyKey`. The store also receives a
`requestHash` — a cheap, order-independent hash of the batch's semantic
content (policy, scope, subject, window, limit, cost for every bucket).

- Same key + same hash → the store returns the *original* outcome without
  consuming again (a true replay, not a fresh evaluation).
- Same key + different hash → `IdempotencyConflictError`. We never
  silently charge twice, and we never silently ignore a materially
  different request under the same key.
- Idempotency records expire (`idempotencyTtlMs`, default 24h) after which
  the key is available for reuse as if new.

The hash is intentionally non-cryptographic (FNV-1a) — it exists to detect
accidental/buggy key reuse with different parameters, not to resist
adversarial collision attacks. Nothing security-sensitive depends on hash
uniqueness.

## 4. Reservation semantics

Reservations are deliberately **single-policy**. Supporting multi-policy
reserve/commit/release would require distributed two-phase-commit-like
coordination across buckets with independent lease clocks — real
complexity for a use case (holding capacity for an operation whose outcome
is uncertain) that in practice maps to one bucket at a time (e.g. "hold one
unit of the user's request quota while an LLM call is in flight").

Lifecycle:

1. `reserve(bucket, leaseMs)` — capacity is held **immediately** (the
   bucket's `used` increases right away), and a reservation record is
   created with `status: 'pending'` and `expiresAtMs`.
2. `commit(id)` — marks the reservation `committed`. The held capacity was
   already applied at reserve time, so commit is a no-op on the bucket
   itself; it just finalizes the reservation record.
3. `release(id)` — returns the held capacity (decrements `used` by the
   reservation's cost) and marks the reservation `released`.

If neither `commit` nor `release` is ever called (the process crashes, a
webhook never arrives, etc.), the reservation expires at `expiresAtMs`.
Both stores check expiry lazily on the next access to that reservation:

- attempting to commit or release an expired reservation raises
  `ReservationExpiredError` and — for the memory store — also releases the
  held capacity right there; the Redis store's held capacity naturally
  frees itself because the *bucket key itself* has its own TTL tied to the
  policy's window, so an abandoned reservation cannot outlive its window
  even if nobody ever touches the reservation record again.

We chose "hold at reserve time" over "hold nothing until commit" because
the entire point of a reservation is to prevent a burst of concurrent
in-flight operations from collectively exceeding the quota before any of
them finishes — that only works if capacity is claimed up front.

## 5. Clock handling

All time access goes through a `Clock` interface (`now(): number`). Nothing
in `core/` or `stores/` calls `Date.now()` or `new Date()` directly for
decision-making. `SystemClock` wraps the real clock in production;
`FakeClock` gives tests deterministic, manually-advanced time with zero
`sleep()` calls.

For the Redis store specifically: window boundaries are computed by *the
application process* using its own clock, not by Redis (`TIME` is never
called). This means quota bucket boundaries can drift slightly between
application servers with clock skew, but:

- the skew is bounded by NTP-typical drift (milliseconds), while windows
  are typically seconds-to-months wide — the practical impact is that a
  request landing within a few ms of a boundary might be attributed to the
  window on one server's clock vs. another's, not that quotas become
  inconsistent or double-counted;
- avoiding a `TIME` round-trip per request keeps the store to one network
  call, which matters far more for throughput than sub-window-boundary
  precision.

If a deployment needs stronger clock guarantees, it can inject a `Clock`
backed by a synchronized time source (e.g. an NTP-disciplined clock, or an
external Redis-timestamp poll cached with a short TTL) without touching
engine or store code.

## 6. Plan changes mid-window

Changing a policy's effective limit (e.g. via `limitResolver` returning a
different value after a plan upgrade) takes effect on the **next**
evaluation. Usage already recorded within the current window is never
reset, truncated, or deleted because the limit changed — usage is a fact
about what happened; the limit is a fact about what's currently allowed.

Concretely:

- limit `1000 → 500`, with 700 already used this window: the very next
  request evaluates `700 + cost > 500` and is rejected. The customer isn't
  retroactively "penalized" beyond the plan effective immediately; they
  simply can't consume further until the window resets.
- limit `1000 → 10,000`, with 700 already used: the next request evaluates
  against the new 10,000, immediately unblocking further usage.

This is the simplest rule that never lies about history and never requires
a migration step when a plan changes mid-cycle. Applications that want a
grace period or pro-rated behavior across a plan change should implement
it above this library (e.g. by not swapping the resolved limit until the
next window boundary in their own `limitResolver`).

## 7. Redis failure behavior / fail-open vs fail-closed

`failureMode` is `'open' | 'closed'`, set once at configuration time — the
engine never switches between them at runtime based on heuristics.

- **`closed`** (the default): a store failure raises `QuotaStoreError`.
  The NestJS guard maps this to **HTTP 503**, distinct from the **429** it
  uses for an actual `QuotaExceededError`. A caller (or its retry logic)
  can always tell "the quota system is down" apart from "you're over
  quota" by status code alone, without parsing response bodies.
- **`open`**: a store failure returns an *allowed* decision with
  `degraded: true`. The statuses returned are synthesized (limit as
  reported by policy resolution, `used: 0`) since the real usage is
  unknowable — they exist only so response headers have something
  sensible to report, not as an accounting claim.

We chose an explicit boolean-like enum, set once, over any kind of
"circuit breaker that flips modes automatically" because automatic mode
switching is itself a source of surprising, hard-to-reason-about behavior
under partial outages — exactly the situation where predictability matters
most.

## 8. Key generation

Bucket keys have the shape:

```
<namespace>:quota:<policy>:<scope>:<subject>:<windowStartMs>
```

- `namespace` defaults to `quota` and is configurable, so multiple
  applications (or multiple `QuotaModule` instances) can safely share one
  Redis instance.
- `policy`, `scope` are validated at policy-definition time against a
  strict allow-list pattern (`A-Za-z0-9_-.:@`) and a length cap, so they
  can never inject extra key segments.
- `subject` is validated the same way, but additionally: subjects longer
  than 128 characters are replaced with a hash (`h<8-hex-chars>` via
  FNV-1a) rather than embedded verbatim. This bounds key length regardless
  of what identifiers an application's identity resolver produces, and
  caps the "cost" of a maliciously long subject to a fixed-size key
  segment rather than unbounded Redis memory per distinct value.
- The window is embedded as `windowStartMs` directly — a sufficient,
  stable discriminator, since the policy's window spec doesn't change
  between calls for a given policy name and the policy name is already
  part of the key.
- As a final safety net, if the fully-assembled key would still exceed 512
  characters, the whole key is replaced with
  `<namespace>:quota:h<hash-of-full-key>`.

Idempotency keys and reservation IDs follow the same
namespace-prefixed, length-bounded, hashed-when-long pattern
(`buildIdempotencyKey`, `buildReservationKey`).

## 9. High-cardinality protection

Two independent mechanisms bound the blast radius of many distinct
subjects:

1. **Key-level**: the subject-hashing described above means a bucket key's
   size is bounded regardless of subject length, so an attacker supplying
   arbitrarily long "subject" strings (if such input ever reached identity
   resolution — which it should not, see §11) cannot grow Redis memory
   per-key.
2. **Expiration**: every bucket key carries a TTL matching its window's
   remaining lifetime. A flood of one-off subjects (real or attempted
   abuse) self-cleans at the next window boundary rather than accumulating
   forever. The in-memory store additionally supports a periodic sweep
   (`sweepIntervalMs`) as a belt-and-suspenders cleanup, though lazy
   per-access expiration means correctness never depends on the sweep
   actually running.

Overall cardinality control (i.e. "should this subject be allowed to
create quota buckets at all") is an application-level authorization
concern; this library provides the bounding mechanisms, not a policy
decision about which subjects are legitimate.

## 10. HTTP status mapping

- `QuotaExceededError` → **429 Too Many Requests**, with `limit`,
  `remaining`, `resetAt`, and `retryAfterSeconds` surfaced both in the
  response body and (unless disabled) as headers (`X-RateLimit-*`,
  `Retry-After`).
- Any other engine/store error (`QuotaStoreError`, and defensively any
  other `QuotaError` subtype the guard doesn't specifically expect) →
  **503 Service Unavailable**. Internal storage details (Redis error
  messages, stack traces) are never included in the response body — only
  a generic `QUOTA_UNAVAILABLE` code and message.

This mapping is enforced in exactly one place (`QuotaGuard.canActivate`'s
catch block), so it can't drift between routes.

## 11. Untrusted identity

The engine and guard never derive `scope`/`subject` from raw,
unauthenticated request data. `QuotaModuleOptions.identityResolver` is a
function the *host application* supplies, and it receives the full
`ExecutionContext` — meaning it can (and should) read from
already-authenticated state (`request.user.tenantId`, an API-key record
looked up and attached earlier in the pipeline, etc.), not from a client-
supplied header taken at face value. This is a documentation/API-shape
decision, not something the library can enforce mechanically — but making
the resolver a required, explicit function (rather than, say, a magic
header name string) is meant to make the "resolve from authenticated
context" pattern the path of least resistance.

## 12. Avoiding double charging

Three independent safeguards:

1. **Guard-level de-duplication.** Every processed request is marked via a
   symbol-keyed property (`QUOTA_REQUEST_STATE`) on the request object
   itself. If a second `QuotaGuard` instance runs against the *same*
   request object (e.g. a global guard plus a per-controller
   `@UseGuards(QuotaGuard)`), it sees the marker and returns `true`
   immediately without consuming again.
2. **Single-purpose separation of concerns.** The guard performs admission
   control (check/consume/reserve); the interceptor
   (`QuotaMeterInterceptor`) performs *post-hoc metering* against a
   *different* policy in the common case (e.g. a pre-request "requests/
   minute" quota via the guard, plus a post-request "tokens used" meter via
   the interceptor). Nothing stops an application from pointing both at the
   same policy, but that is a deliberate modeling choice the application
   makes, not something the library does implicitly.
3. **Documentation.** `QuotaModule.forRoot` explicitly does *not* register
   any guard globally — the host application opts in per-route or per-
   controller, or globally, on purpose. This doesn't prevent
   misconfiguration by itself, which is exactly why (1) exists as the
   actual runtime safety net.
