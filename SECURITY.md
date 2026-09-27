# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, email the maintainers at `security@example.com` (replace with a
real address before publishing) with:

- A description of the vulnerability and its potential impact.
- Steps to reproduce, or a minimal repro repository.
- The package version(s) affected.

We aim to acknowledge reports within 3 business days and to ship a fix or
mitigation within 30 days for confirmed issues, depending on severity.

## Supported versions

Only the latest major version receives security fixes. See
[`CHANGELOG.md`](./CHANGELOG.md) for the current version.

## Scope and threat model

This package is infrastructure for **quota enforcement and usage
metering**. Relevant security properties it is designed to uphold:

- **Cross-tenant isolation.** Two distinct `(policy, scope, subject)`
  triples must never resolve to the same storage key, and one tenant must
  never be able to read or influence another tenant's quota state through
  key construction. See [`docs/design.md §8`](./docs/design.md#8-key-generation).
- **Bounded resource usage.** Arbitrarily long or high-cardinality
  identifiers supplied to the engine must not cause unbounded memory
  growth in the store. See
  [`docs/design.md §9`](./docs/design.md#9-high-cardinality-protection).
- **No internal detail leakage.** Store-level errors (e.g. raw Redis error
  text) must never be included in HTTP responses.
- **No double charging** and **no lost updates** under concurrency — see
  [`docs/design.md §2 and §12`](./docs/design.md).

Out of scope (the responsibility of the host application):

- **Identity/authentication.** This library does not authenticate
  requests. `identityResolver` must be supplied by the host application and
  must derive scope/subject from already-authenticated context, never from
  raw, unauthenticated request fields. A misconfigured resolver that trusts
  a client-supplied header is an application-level vulnerability, not one
  this library can detect or prevent.
- **Authorization** (whether a given tenant/user is allowed to perform the
  operation at all, independent of quota).
- **Transport security** (TLS to Redis, TLS on the HTTP server) — configure
  this in your `ioredis`/NestJS setup as you would for any other
  connection.
- **Redis instance hardening** (auth, network exposure, `ACL` policies) —
  standard Redis operational security applies.

## Known-safe defaults

- `failureMode` defaults to `'closed'` (reject on store failure), the
  conservative choice.
- Response headers never include internal storage details.
- Idempotency and reservation records carry bounded TTLs by default; there
  is no unbounded-growth code path for either.
