# Decisions and assumptions

The PRD Decision Register (D-01 … D-12) leaves several items open. Where the build had to choose, the choice is recorded here, is set as a default in `packages/contracts/src/defaults.ts` or `.env.example`, and can be changed per tenant (within platform bounds) unless noted.

## Engineering decisions (DEC)

| ID | Decision | Reason | Revisit when |
|---|---|---|---|
| DEC-01 | Modular monolith in TypeScript on Node 22, run with `tsx` (no compile step on the server) | TS §4; fewer moving parts for an MVP; one language across API, web and mobile core | Throughput needs splitting the worker |
| DEC-02 | HTTP pipeline built on `node:http` instead of Fastify | No package registry in the build environment; the pipeline (`modules/kernel/http.ts`) is small and fully tested | Network available — Fastify can wrap `App.handle` |
| DEC-03 | Server-sent events + catch-up endpoint instead of Socket.IO | Clients only receive realtime data; SSE works through proxies, needs no library, and reconnect/catch-up is explicit | Two-way realtime needed |
| DEC-04 | In-repo validator (`packages/contracts/src/schema.ts`) with a Zod-like API instead of Zod | No registry; rejects unknown fields and operator keys by default, which Zod needs `.strict()` for | Swap is mechanical (same `s.object/…` shape) |
| DEC-05 | Password hashing: scrypt (N=32768, r=8, p=3) by default, Argon2id via `PASSWORD_ALGO=argon2id` with the optional `argon2` package | scrypt is memory-hard and built into Node; Argon2id needs a native module that could not be installed. Hashes record their algorithm and parameters and are upgraded on next login | Install `argon2` and set the variable |
| DEC-06 | Durable job queue in the database (`jobs` collection, leases, HMAC-signed payloads) instead of Redis/BullMQ | One less service to operate; same guarantees (priority, retry, dead state, crash recovery) are tested | Job volume beyond one database |
| DEC-07 | Transactional outbox → relay → realtime hub, with per-tenant sequence numbers | Realtime and jobs only see committed data; clients can catch up after a gap | — |
| DEC-08 | Storage port with MemoryStore (tests), FileStore (single-node dev/demo) and MongoStore (production) | Tests run without services; demo runs anywhere; production uses MongoDB transactions as TS §6 requires | — |
| DEC-09 | Map: SVG map with an optional tile URL template per tenant (no bundled tile provider), grid clustering | Free; no API key; coordinates still exact. MapLibre can replace `apps/web/src/map.tsx` | Tenant needs vector maps |
| DEC-10 | Access token EdDSA JWT 15 min; refresh opaque, rotated, family revocation; web refresh in HttpOnly cookie + CSRF double submit | TS §9 | — |
| DEC-11 | Device proof of possession: Ed25519 key per installation, signature over `METHOD\npath\nsha256(body)\ntimestamp`, ±5 min skew | TS §9.4; replay inside the window is stopped by idempotency keys | — |
| DEC-12 | Audit hash chain per tenant: `sha256(prevHash + canonicalJson(event without _id/hash))` | Ids are assigned by the store; including them made the chain store-dependent | — |
| DEC-13 | Location points thinned on device (moving/stationary intervals, ≥ 10 m change) and on server (duplicates, > 250 km/h jumps flagged not dropped) | PRD location quality rules; flagged points stay visible to reviewers | — |
| DEC-14 | Freshness classes computed at read time from `effectiveTime = min(recordedAt, receivedAt)`: Live ≤ 2 min, Recent ≤ 10 min, Stale ≤ 60 min, otherwise Unknown | A fast device clock cannot make data look fresh. Thresholds are tenant settings | — |
| DEC-15 | Geofence evaluation is accuracy-aware: inside only if distance + accuracy ≤ radius, outside only if distance − accuracy > radius, otherwise "uncertain"; exit needs 2 consecutive outside fixes and 60 s dwell | Avoids false "left post" alerts from poor GPS | — |
| DEC-16 | Recurrence: RRULE subset (DAILY/WEEKLY with BYDAY, INTERVAL, COUNT, UNTIL); occurrences resolved in the post's IANA timezone; a wall time that does not exist (DST gap) moves forward, an ambiguous one takes the first instance | DST-safe; covers PRD scenarios | Monthly patterns needed |
| DEC-17 | Overnight shifts belong to their start date | Matches how rosters are read | — |
| DEC-18 | Web portal: React 19 bundled by esbuild (no Vite) | esbuild was installed; same output | — |
| DEC-19 | Mobile: Expo SDK 52 app over a platform-independent `mobile-core` package that holds all sync, queue, SOS and signing logic | The logic can be tested without devices; the Expo layer is thin | — |
| DEC-20 | Tenant export is a TAR of JSON lines + files with a manifest of SHA-256 sums; deletion produces a signed certificate | Standard tools can open it; no ZIP library needed | — |
| DEC-21 | Reports are CSV only (formula-neutralised); PDF export not built | No PDF library available | Add a renderer |

## Defaults for open PRD decisions

| PRD item | Default chosen | Where |
|---|---|---|
| D-01 Pilot organisation type | Generic security/guarding; terminology labels let a tenant rename "post", "duty", "officer" | `DEFAULT_LABELS` |
| D-02 Location sampling | Moving 30 s, stationary 120 s, minimum distance 10 m, break mode pauses sampling | `DEFAULT_SETTINGS.location` |
| D-03 Retention | Location points 90 days, attendance and incidents 2 years, audit 7 years, notifications 180 days; legal hold overrides | `DEFAULT_SETTINGS.retention` |
| D-04 Late start threshold | 10 min grace, alert at 15 min | `DEFAULT_ALERT_RULES` |
| D-05 Escalation | Step 1 supervisor at 0 min, step 2 commander at 5 min, step 3 Owner/Admin at 15 min if not acknowledged | `DEFAULT_ALERT_RULES` |
| D-06 SOS recipients | Supervisor of the unit, commander chain, dispatchers with `sos.respond`; never acknowledged automatically | safety module |
| D-07 Checkpoint method | QR (static or rotating 30 s TOTP-style code) for MVP; NFC field accepted by the API, reading not implemented in the app | `CHECKPOINT_METHODS` |
| D-08 Device policy | One active device per person; a second device needs approval; minimum app version enforced except for SOS | `DEFAULT_SETTINGS.devices` |
| D-09 Push/SMS provider | **Not chosen** — no provider integrated (no paid services without approval). In-app notifications and realtime are the source of truth; SMTP email optional | FR-MOB-008 gap |
| D-10 Plans | Starter (50 staff), Professional (500), Enterprise (unlimited); limits enforced on staff creation, no billing | `DEFAULT_PLANS` |
| D-11 Capacity target | 1,000 on-duty staff per tenant, 10 tenants; load test runs 300 staff in-process | `npm run load` |
| D-12 Languages | English and Arabic (RTL) at launch | `packages/i18n` |

## Assumptions

- Staff use company or personal Android/iOS phones with GPS; web users use a current desktop browser.
- A tenant has one primary timezone; posts may override it.
- Employee codes are unique within a tenant and used as sign-in usernames (lower-cased).
- "On duty" means a duty start was recorded for an assignment and no duty end yet; location is collected only during that time and during an active SOS.
- Supervisors see their own unit and descendants; commanders their assigned units and descendants; Owner/Admin/Auditor the whole tenant (auditor read-only).
- Arabic strings were written by the build, not by a native speaker; they need review before a launch.
- The demo organisation, people and places are fictional and marked as demo everywhere.
