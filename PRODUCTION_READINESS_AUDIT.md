# SmartForce 360 — Production Readiness Audit

**Date:** 2026-11-13 · **Scope:** whole repository (API, 13 server modules, web portal, mobile core, Expo app source, infrastructure) · **Companion reports:** `PRODUCTION_TEST_REPORT.md`, `PRODUCTION_DEPENDENCIES.md`

**Not changed in this audit, by instruction:** the 2FA/MFA implementation. One MFA defect was found and is reported below (§3, A-07) but left unfixed.

## 1. Verdict

The web platform and API work end to end with real persistence, and checks and tests confirm every advertised web/API workflow. This audit found **no broken user-facing workflow, fake data or false-success path** in the web portal or API. The defects it did find were in the build/verification chain, in deployment configuration and in tooling, plus one MFA display defect. All of them except the MFA one are fixed.

**The platform is not yet production-ready**, for reasons outside the code:

- The **MongoDB** production store has never been run.
- The **Expo mobile app**, which is the only place GPS is captured in the field, has never been built or run on a phone.
- **Real-device GPS** could not be verified, because location services are off on this machine.
- **Email, map tiles, push and SMS** have no provider configured.

These are listed with exact requirements in `PRODUCTION_DEPENDENCIES.md`.

## 2. Module inventory and status

Legend: **PASS** = implemented and verified by executed tests or live runs · **FAIL** = tested and failed · **BLOCKED** = cannot be verified until a named dependency is supplied · **NOT APPLICABLE** = the feature does not exist in this project.

| # | Module | Status | Evidence (see test report) |
|---|---|---|---|
| 1 | Authentication: password, lockout, sessions, refresh rotation, CSRF | **PASS** | security tests; browser steps 1–2, 12; live HTTP |
| 2 | MFA / 2FA (TOTP, enrolment, recovery-code *verification*) | **PASS** | security + MFA tests; browser step 12 |
| 2a | MFA: recovery codes *shown to the user* after enrolment | **FAIL** | A-07, not fixed: MFA is frozen for this task |
| 3 | Platform Super Admin console (tenants, plans, usage, lifecycle, support grants, health) | **PASS** | operations test + new `platform-console.test.ts` (7 previously untested routes) |
| 4 | Multi-tenancy and cross-tenant isolation | **PASS** | TR-001 attack test on every route; boundary lint |
| 5 | Roles and permissions (7 roles, 79 keys, custom roles, hierarchy scope) | **PASS** | TR-002 matrix test; scope test; browser step 11 |
| 6 | Organisation: units, posts, teams | **PASS** | integration tests |
| 7 | Workforce: staff lifecycle, CSV import, invitations | **PASS** | integration tests |
| 8 | Devices: registration, second-device approval, revocation, signing | **PASS** | device tests; approval workflow over live HTTP |
| 9 | Duty planning: shifts, assignments, rosters, publish, acknowledgement | **PASS** | J2; browser step 8 |
| 10 | Attendance: start/end/breaks, gates, corrections, review | **PASS** | J3, J8 |
| 11 | GPS server pipeline: signed ingestion, dedupe, freshness, live view, purpose-gated history | **PASS** | J3, J5; field simulator over live HTTP; browser steps 5–6 |
| 11a | GPS capture on a real phone (Expo app, expo-location) | **BLOCKED** | needs an Android/iOS device and an Expo build |
| 11b | GPS capture from a real browser location fix | **BLOCKED** | Windows location services are **Off** on this machine; Chrome correctly refuses |
| 12 | Live/stale/unavailable/denied distinctions | **PASS** | freshness tests; browser step 5; denied-permission check in `gps-browser.ts` |
| 13 | Geofencing (circle/polygon, hysteresis) | **PASS** | geofence tests |
| 14 | Checkpoints (static and rotating QR) | **PASS** (server) / **BLOCKED** (camera scan) | checkpoint tests; camera needs a device |
| 15 | Command centre and live map | **PASS** | browser steps 3–5; SSE realtime |
| 15a | Map base layer (street tiles) | **BLOCKED** | no tile server configured; the map falls back to a plain grid |
| 16 | Alerts: rules, evaluators, escalation, lifecycle | **PASS** | J6; browser step 7 |
| 17 | SOS and incidents | **PASS** | J7; browser step 4; offline SOS over live HTTP |
| 18 | In-app notifications | **PASS** | notifications test |
| 18a | Email (SMTP) | **BLOCKED** | `SMTP_HOST` is empty |
| 18b | Push / SMS | **NOT APPLICABLE** | no code exists (documented MVP gap FR-MOB-008); needs a provider decision |
| 19 | Reports (11) and CSV export | **PASS** | J9; browser step 9 |
| 19a | XLSX / PDF export | **NOT APPLICABLE** | only CSV exists |
| 20 | Audit log (hash chain, verification, search) | **PASS** | audit test; browser step 12 |
| 21 | Privacy: notices, self-view, subject export/deletion, retention | **PASS** | J3; retention test |
| 22 | Settings and catalogues | **PASS** | settings test |
| 23 | Files: upload validation, metadata stripping, signed links | **PASS** | operations tests |
| 24 | Background jobs, outbox, schedulers | **PASS** | durability tests; worker ran in-process during live HTTP runs |
| 25 | Web portal UI (EN/AR, RTL, responsive) | **PASS** | 15/15 browser steps; contract check (207 call sites → real routes) |
| 26 | Mobile core (offline queue, sync, SOS, signing) | **PASS** | mobile-core tests; field simulator over HTTP |
| 27 | Mobile app UI (Expo) | **BLOCKED** | never compiled or run on a device |
| 28 | MongoDB production store | **BLOCKED** | no MongoDB on this machine; `npm run test:mongo` not run |
| 29 | Performance on the real stack | **BLOCKED** | measured in-memory only |
| 30 | Accessibility (full WCAG 2.2 AA audit) | **BLOCKED** | built-in checks pass; no axe-core or manual audit |
| 31 | Backup/restore drill | **BLOCKED** | scripts exist; a drill needs MongoDB |

## 3. Issues found

| ID | Severity | Area | Issue and impact | Root cause | Status |
|---|---|---|---|---|---|
| A-01 | **High** | Build / CI | `npm run verify` and the CI `typecheck` step fail on any fresh checkout. | `tests/e2e-web/run.ts` imports `playwright`, which was never declared in `package.json`. | **Fixed**: added `playwright@1.64.1` (pinned, devDependency). |
| A-02 | **High** | Deployment | A Docker deployment using the current `.env` would refuse to start. | `docker-compose.yml` loads `.env` (`env_file`), and `.env` held `AUTH_MFA_REQUIRED=false` (added in the earlier dev-MFA task). Production correctly rejects that value. | **Fixed**: `.env` now has `AUTH_MFA_REQUIRED=true`. Local password-only testing still works through `npm run dev:no-mfa`, which sets its own variables. |
| A-03 | Medium | Tooling | `npm run lint:boundaries` fails on Windows with two false violations in `modules/kernel/events.ts`. | The kernel exemption compared paths using `/`, but Windows paths use `\`. | **Fixed**: separators are normalised. Verified the lint still catches a planted real violation. |
| A-04 | Medium | Tooling / evidence | The field simulator cannot run against a seeded demo; every phone reports "no tracking session". `FINAL_REPORT.md` says it passed, but that can't be reproduced. | The demo seed gives each officer a device, so the simulated phone is a second device, which correctly gets `DEVICE_NOT_APPROVED`. The simulator ignored that. | **Fixed**: new `--approver <commander>` option uses the real approval workflow, and the messages are clearer. Re-run passed over live HTTP. |
| A-05 | Medium | Test coverage | 7 Platform Super Admin routes had no test: profile, plans, tenant detail, rename, usage, resume, logout. | Gap in the existing suite (found by runtime route coverage). | **Fixed**: `tests/integration/platform-console.test.ts`. No product bug found. All 202 routes are now exercised. |
| A-06 | Medium | GPS evidence | Nothing verified the pipeline with a real location fix. | Tests and the simulator use synthetic coordinates. | **Tool added**: `tests/e2e-web/gps-browser.ts` takes a real permitted Chrome fix through ingestion → live view → stale ageing → history → isolation. It is **blocked** here because Windows location is Off. |
| A-07 | **High** | MFA (frozen) | After setting up MFA, users never see their recovery codes, so they can't use them later. | `toApi()` in `modules/kernel/http.ts` deletes every `recoveryCodes` key from API responses (meant for stored hashes), including the one-time plain list returned by `/auth/mfa/confirm`. | **Not fixed (MFA is frozen for this task).** Suggested fix: return the plain codes under a different key (e.g. `newRecoveryCodes`) and read that key in `apps/web/src/main.tsx`. Needs your approval. |
| A-08 | Low | Docs | `FINAL_REPORT.md` and `docs/TEST_RESULTS.md` quote 58 tests. `docs/RTM.md` says `npm audit` was never run. | Written before later work. | Superseded by `PRODUCTION_TEST_REPORT.md` (now 62 tests; `npm audit` run: 0 vulnerabilities). |

**Checked, no defect found:**
- No TODO/FIXME/placeholder/mock data in application code. The only "mock" hits are the mock-location *detection* signal.
- All 207 API call sites in the web portal and mobile core map to real routes with matching HTTP methods.
- Security headers (CSP, HSTS behind TLS, nosniff, frame-deny) are set.
- Graceful shutdown is handled for both the API and the worker.
- Production config refuses demo mode, missing secrets, non-HTTPS URLs and the dev MFA bypass.
- Response serialisation strips secret fields. Logs redact secrets (log-hygiene test).
- `npm audit`: 0 vulnerabilities.
- Your `.env` (secrets present, values not printed) passes production validation after A-02.

## 4. Changes made in this audit

All originals are backed up as `*.bak-20261113-audit`.

| File | Change |
|---|---|
| `package.json`, `package-lock.json` | `playwright` 1.64.1 devDependency (A-01) |
| `scripts/boundary-lint.ts` | Windows path normalisation (A-03) |
| `.env` | `AUTH_MFA_REQUIRED=true` plus an explanatory comment (A-02) |
| `tools/field-simulator.ts` | `--approver` option, clearer messages (A-04) |
| `tests/integration/platform-console.test.ts` | new (A-05) |
| `tests/e2e-web/gps-browser.ts` | new (A-06) |
| `PRODUCTION_*.md` | these reports |

No application behaviour, schema, permission, MFA code or user data was changed.

## 5. Remaining blockers before production
1. Run `npm run test:mongo` against a MongoDB 7 replica set and fix anything it finds.
2. Build the Expo app, then test on at least one Android phone: background tracking, foreground-service notice, QR camera, SOS, offline/restart.
3. Verify real GPS (phone, or the browser script with location services on).
4. Configure email (SMTP) and a map tile provider. Decide on push (and SMS if wanted).
5. Approve and apply the A-07 recovery-code fix.
6. Load-test and run a backup/restore drill on the real stack. Run an accessibility audit (axe-core plus manual).
