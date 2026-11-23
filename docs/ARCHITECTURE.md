# Architecture

A modular monolith (TS §4) with three process roles that share one codebase: **API** (HTTP + server-sent events), **worker** (outbox relay, durable job queue, schedulers) and the **web portal** (static bundle served by the API). In a single-node or development deployment the API runs the worker in-process.

```
 Phone (Expo app) ─┐                         ┌─ MongoDB (replica set) / file store
  mobile-core      │  HTTPS /api/v1          │
 Browser (React) ──┼──► API ── kernel ──► modules ──► Store port
                   │   SSE  /realtime/stream │        │
                   │                         │        └─► outbox_events, jobs  ──► Worker: relay → realtime hub,
                   └─────────────────────────┘                                       job handlers, schedulers
```

## Request pipeline (`modules/kernel/http.ts`)

Every route is registered with mandatory metadata: **permission**, **scope** (`tenant` / `unit` / `own` / `platform` / `none`), **audit** action (or a written reason for not auditing), **rate class**, optional **body/query schema**, `deviceBound`, and behaviour when the tenant is not active. A test fails if any route lacks it. Each request goes through, in order:

1. body size limit → route match → **authentication** (EdDSA JWT; session, user, membership, staff and tenant re-read from the store on every request, so revocation is immediate)
2. **tenant state** (suspended/archived/pending deletion allow only safety actions, Owner export, or reads)
3. **device** (revoked → 403; app version below minimum → 426, SOS exempt) → **permission** (denials audited)
4. **device proof of possession** for duty actions (Ed25519 signature over method, path, body hash and timestamp)
5. **rate limit** (token bucket per class and key; SOS never limited) → **validation** (unknown fields and operator keys rejected)
6. **Idempotency-Key** replay → handler inside a **transaction** → **audit event** in the same transaction → response shaping (`_id`→`id`, timestamps → ISO-8601, secret fields stripped)

Handlers apply **scope** themselves through `ctx.assertScope` / `ctx.scopeFilter`; an out-of-scope id is reported as *not found*.

## Tenant isolation

Modules never touch the store directly for tenant data: `ctx.col(name)` returns a `ScopedCollection` that injects `tenantId` into every filter and insert and refuses non-tenant collections. The schema inventory (`modules/kernel/store.ts`) marks each collection tenant-owned or platform, declares unique keys (always tenantId-prefixed) and indexes, and flags append-only collections, which reject updates and deletes outside the retention job. `npm run lint:boundaries` fails if module code queries a tenant collection without a tenantId. `tests/integration/security.test.ts` calls every route with another tenant's ids (3,000+ requests) and fingerprints the victim tenant's data before and after.

## Modules

| Module | Responsibility |
|---|---|
| `identity` | Sign-in, MFA (TOTP + recovery codes), refresh rotation with reuse detection, activation, reset, email verification, sessions |
| `tenancy` | Platform console, provisioning (one transaction), lifecycle, settings versions with platform bounds, support grants, legal holds, plan/usage, deletion |
| `access` | Roles (defaults fixed, custom by cloning), membership roles and hierarchy scope, no privilege escalation |
| `organisation` | Units (materialised ancestor paths, move/merge, ≤ 10 levels), posts, teams |
| `workforce` | Staff, lifecycle with access withdrawal, CSV import, devices (key binding, approval, revocation, heartbeat), signed mobile config |
| `privacy` | Notice versions and acknowledgement gate, self-view, location access log, subject export and deletion |
| `duty` | Shifts with RRULE subset and DST-safe occurrences, assignments, overlap policy, roster versions with diff, acknowledgement, coverage |
| `attendance` | Duty start/end/breaks (append-only events), corrections, duty summary with basis labels, supervisor review |
| `field` | Tracking sessions, location ingestion, latest-state projection, geofence hysteresis, checkpoints, offline sync, SSE + catch-up |
| `safety` | Alert rules, dedupe, lifecycle, escalation jobs, scheduled evaluators, SOS, incidents |
| `notifications` | In-app notifications (source of truth), SMTP email adapter |
| `records` | Reports and CSV export, files (sniffing, metadata stripping, signed links), audit search/verify, retention, tenant export and deletion |

Pure rules (geometry, recurrence, freshness, scan validation, state machines, CSV safety, hash chain, TOTP) live in `packages/domain` and `packages/contracts` and are shared with the web and mobile clients.

## Events, jobs and realtime

Business writes add **outbox** rows and **jobs** in the same transaction. The relay publishes committed events in order with a per-tenant sequence number to the **realtime hub**. The hub computes visibility from the subscriber's tenant, permissions and unit scope (clients never name rooms), strips coordinates for roles without `location.live.read`, and coalesces location updates to one per person per second (SOS and alerts are never dropped). Clients reconnect and call `/realtime/catch-up?since=<seq>` (15-minute window, otherwise reload). Open streams re-check the session and scope every 10 s.

Jobs are priority-ordered (critical → alerts → notifications → … → retention), HMAC-signed (tampered payloads go to the dead state), retried with backoff and recovered if a worker crashes mid-job. Handlers are idempotent; escalation is deduplicated per step. Schedulers (late start, missed check-out, stale location, device offline, missed checkpoints, acknowledgement reminders, retention, audit verification, deletion) run every 30–60 s per tenant and are safe to run twice.

## Data and time

Times are stored as UTC epoch milliseconds and returned as ISO-8601. Shift times are wall-clock times in the post's IANA timezone; each occurrence is resolved to UTC at creation (overnight shifts belong to the start date). Location points keep `recordedAt` (device), `receivedAt` (server) and `effectiveTime = min(both)` so a fast device clock cannot make data look fresher. Freshness is always computed at read time.

## Deviations from the Technical Specification

See `docs/DECISIONS_AND_ASSUMPTIONS.md`. In short: the build environment had no network, so dependencies were limited to what was installed. The HTTP layer, validation, JWT, TOTP and job queue are implemented in-repo on Node built-ins instead of Fastify/Zod/BullMQ+Redis; Socket.IO is replaced by server-sent events; MapLibre by a small SVG map with optional tile URL; Argon2id is available as an adapter with scrypt as the default. MongoDB remains the production store behind the same `Store` port; a file-backed store exists for single-node development and demos.
