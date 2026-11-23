# SmartForce 360 — final implementation report

**Date:** 2026-11-12 · **Version:** 0.1.0 (MVP build) · **Sources:** PRD v2.1, Technical Specification v2.1, Master Development Prompt v2.1

## 1. Summary

The web platform and API are built with real persistence, APIs, validation, workflows and security controls, and are covered by 58 passing automated tests plus a 15-step browser test. The mobile app's logic (offline queue, sync, SOS, device signing) is built and tested; its Expo user-interface layer is written but has **not** been compiled or run on a device. The MongoDB production adapter is written but has **not** been run.

Requirement status from `docs/RTM.md` (138 PRD requirements):

| Status | MVP | All |
|---|---|---|
| Verified (automated test) | 84 | 84 |
| Verified (browser) | 6 | 6 |
| Implemented (code + manual check, no dedicated test) | 8 | 9 |
| Partial (gap stated in RTM) | 16 | 16 |
| Unverified (device) | 5 | 5 |
| Not implemented | 3 | 18 (15 are R2/ENT phase) |

MVP items **not implemented**: FR-MOB-005 battery measurement (needs devices), FR-MOB-008 push notifications (no provider chosen; would need an account — not set up without your approval), FR-NFR-001 99.5 % availability (an operational target of the deployment).

## 2. Completed modules

| Module | What is in it | Evidence |
|---|---|---|
| Multi-tenancy and platform console | Provisioning (atomic, idempotent), lifecycle (active/suspended/archived/deletion), plans and limits, usage, health, support grants and break-glass, legal holds, ownership transfer | J1, J10, platform tests |
| Authentication | Password + TOTP MFA (mandatory for privileged roles), recovery codes, refresh rotation with reuse detection, web cookie + CSRF, activation codes, reset, lockout, session management | 3 security tests |
| Roles and permissions | 7 default roles, 79 permission keys, custom roles by cloning, hierarchy scope, no escalation | TR-002 matrix, scope test |
| Tenant isolation | Scoped repositories, schema inventory, boundary lint, cross-tenant attack test on every route | TR-001 |
| Organisation | Unit tree (move, merge, cycle checks), posts, teams | org test |
| Workforce and devices | Staff lifecycle with access withdrawal, CSV import with dry run, bulk update, device keys, approval, revocation, heartbeat, signed mobile config | J10, import, device tests |
| Duty management | Shifts with DST-safe recurrence, assignments, overlap policy, roster publish with versions and diff, acknowledgement, coverage | J2, planning tests |
| Attendance | Duty start/end/breaks with gates (window, privacy notice, geofence policy, clock skew), missed check-out policies, corrections, summaries, review | J3, J8, gates test |
| GPS tracking | Tracking sessions only on duty, batch ingestion, thinning, quality flags, freshness, latest state, history with purpose and employee-visible access log | J3, J5, locations test |
| Geofencing | Circle/polygon with validation, versioning, accuracy-aware hysteresis, exception alerts | geofence tests |
| Checkpoints | QR static and rotating, validation order, ordered/flexible plans, missed checkpoint alerts, tag reissue | checkpoints test |
| Command centre | Live map and list with SSE realtime, scope-filtered, freshness never shown as live when stale, clustering, staff panel, SOS banner | J5, browser test |
| Alerts | Rules, scheduled evaluators, dedupe, lifecycle, escalation steps, auto-resolve | J6, durability test |
| SOS | Device-signed, never rate-limited, one incident, escalation until a person acknowledges, offline queue sends first | J7, mobile-core, simulator |
| Incidents | Types, severities, lifecycle, timeline, attachments | J7, operations tests |
| Notifications | In-app (deduplicated), EN/AR templates, SMTP email adapter | notifications test |
| Reports and exports | 11 reports with as-of, timezone and basis labels; CSV export job with formula neutralisation; short-lived signed links | J9, browser test |
| Audit | Append-only hash chain per tenant, before/after, denials recorded, verification job, search UI | audit test, browser test |
| Privacy | Notice versions and acknowledgement gate, self-view of own data, subject export/deletion, retention with legal hold | J3, retention test |
| Settings | Versioned tenant settings within platform bounds, labels, catalogues | settings test |
| Web portal | Overview, command centre, alerts, incidents, planner, attendance, reports, notifications, my data, help, staff, devices, organisation, sites, roles, settings, privacy, audit, account, platform console; English/Arabic RTL; responsive | 15-step browser test, screenshots |
| Mobile | `mobile-core` sync engine (tested); Expo app screens: sign-in, privacy, permissions, My Duty, tracking, QR scan, SOS, sync status | mobile-core tests; app unverified |
| Operations | Health/readiness, Prometheus metrics, JSON logs with redaction, Docker/Compose/Caddy, backup/restore scripts, CI workflow, secrets generator, OpenAPI (202 operations), field simulator, load test | HTTP test, load test |

## 3. Test results
See `docs/TEST_RESULTS.md` and `docs/test-results/`. All checks that could run passed: type checks, two lints, 58/58 automated tests, web build, 15/15 browser steps, traceability, load test, field simulator over HTTP, restore verification.

## 4. Known limitations
1. **Expo app not built or run.** No Android/iOS SDK or devices were available. Background location, the foreground service, QR camera and accessibility on devices need testing (`docs/MOBILE.md`).
2. **MongoDB adapter not run.** All tests use the in-memory and file stores through the same interface. Run `npm run test:mongo` against a replica set before production.
3. **No push or SMS.** In-app notifications, realtime and optional SMTP email only. Choosing a provider (e.g. Firebase Cloud Messaging, which is free) needs an account you create.
4. **Implementation substitutions** (offline build): built-in HTTP pipeline instead of Fastify, in-repo validator instead of Zod, SSE instead of Socket.IO, database job queue instead of Redis/BullMQ, SVG map instead of MapLibre, scrypt by default instead of Argon2id. See `docs/DECISIONS_AND_ASSUMPTIONS.md`.
5. **Load figures are in-memory only**; real-stack capacity is unmeasured.
6. **Accessibility**: built-in checks only; no axe-core run or manual audit.
7. **Arabic text** needs review by a native speaker.
8. **Not built:** PDF report export, NFC reading in the app, malware scanning (port only), field-encryption key rotation job, per-post sampling override, calendar planner view, and the R2/ENT items listed in the RTM (leave, shift swap, SSO, public API, billing…).
9. **`npm audit` and container scanning** were not run (no registry access); configured in CI.
10. Rate limits are per API process.
11. The file store is single-process; use MongoDB for more than one API instance.

## 5. External setup required
| Item | Needed for | Cost |
|---|---|---|
| MongoDB 7 replica set | Production storage | Free (self-hosted) |
| Domain name and server, TLS | Production | Server cost; certificates free (Let's Encrypt via Caddy) |
| SMTP relay | Email notifications (optional) | Your relay; free options exist |
| Expo/Android/iOS toolchains, test phones | Building and testing the app | Free tools; Apple developer account is paid (not purchased) |
| Push provider | FR-MOB-008 | FCM free; needs your account |
| Map tile source | Map background (optional) | Free OpenStreetMap-based tiles within usage policy, or self-hosted |
| Secrets (`npm run secrets`), `.env` | Production start | — |

## 6. How to run
See `README.md`. Short form: `npm install && npm run build:web && npm run seed:demo && npm start`, then open http://localhost:8080 and sign in to organisation `demo` as `cmd-01` / `Demo-Passphrase-2026!`.
