# SmartForce 360 — Production Test Report

**Date:** 2026-11-13 · **Machine:** Windows 11, Node 24, Chrome (installed) · **Stores tested:** in-memory and file. MongoDB was **not** tested (not installed).

Everything below was actually run. The final run was on the finished code, after the last change.

## 1. Final verification run (after the last code change)

| Command | Result |
|---|---|
| `npm run verify` (whole chain below) | **exit 0** |
| ↳ `npm run typecheck` | pass (it failed before fix A-01) |
| ↳ `npm run typecheck:web` | pass |
| ↳ `npm run lint:terms` | pass: 461 keys EN+AR, 17 forbidden terms checked |
| ↳ `npm run lint:boundaries` | pass (it failed on Windows before fix A-03); also confirmed to catch a planted violation |
| ↳ `npm test` | **62 / 62 passed, 0 failed** |
| ↳ `npm run build:web` | pass: 1,616 KiB including source map |
| ↳ `npm run openapi` | pass: 202 operations on 166 paths |
| ↳ `npm run trace` | pass: 138 PRD requirements traced |
| `npm run test:e2e:web` (real Chrome) | **15 / 15 passed** |
| `npm run test:mobile-core` | **3 / 3 passed** |
| `npm audit` | **0 vulnerabilities** |

**Not run:**
- `npm run test:mongo`: no MongoDB → **BLOCKED**.
- Expo app build: no device or SDK → **BLOCKED**.

No test was skipped, weakened or deleted.

## 2. Automated suites (62 tests)

| File | Tests | Covers |
|---|---|---|
| `tests/integration/security.test.ts` | tenant isolation on every route, schema inventory, route metadata, permission matrix, lockout/password policy, MFA, sessions/refresh rotation, devices, audit chain, log hygiene | auth, RBAC, isolation, audit |
| `tests/integration/journeys.test.ts` | J1–J10 end-to-end journeys (provisioning → planning → duty → GPS → alerts → SOS → reports) | cross-module workflows |
| `tests/integration/operations.test.ts` | platform console, settings, imports, geofences, checkpoints, retention, exports, files | operations |
| `tests/integration/http.test.ts` | real HTTP layer, headers, health, metrics | transport |
| `tests/integration/mfa-dev-bypass.test.ts` | dev-only password login; production MFA enforced | MFA policy |
| `tests/integration/platform-console.test.ts` | **new**: profile, plans, tenant detail/rename, usage counts vs store, suspend → resume, tenant users blocked, logout revokes | Super Admin |
| `tests/unit/*.test.ts` | domain rules (freshness, geo, time/DST, rules), mobile-core sync | units |

**Route coverage, measured at runtime** (every route actually dispatched during `npm test`): **202 / 202 routes**. Before the new test it was 195 / 202; the 7 missing were all Platform console routes.

**API contract check:** all 207 API call sites in the web portal and mobile core map to an existing route with the right HTTP method.

## 3. Real browser end-to-end (Chrome via Playwright, built portal + live API + background worker)

All 15 steps passed:
1. Login page renders and is accessible.
2. A wrong password shows the neutral error.
3. A commander signs in; the overview shows live counters and the demo banner.
4. The SOS banner shows and opens the incident.
5. The command centre lists people with state and freshness; a stale person is not shown as on duty.
6. Location history needs a purpose and shows points.
7. The alerts list shows a late start and the SOS; acknowledging updates the state.
8. The duty planner shows today's published assignments with acknowledgement state.
9. A report runs with as-of, timezone and basis labels.
10. Arabic switches the whole interface to right-to-left.
11. A field officer sees no command centre (permission-aware navigation).
12. The owner signs in **with MFA**; audit integrity verifies; a staff activation code is shown once.
13. The help page offers a support contact and a diagnostics bundle without secrets.
14. A narrow (mobile) viewport keeps the portal usable.
15. No uncaught page errors or console errors.

Screenshots: `tests/e2e-web/screenshots/`.

**Browser/device coverage:** desktop Chrome, plus a narrow mobile-sized viewport in Chrome. No Firefox, Safari or real phone browsers were tested.

**Not clicked in a browser** (covered at API level by integration tests only): staff/device/organisation/sites/roles/settings admin screens, and the platform console UI.

## 4. Live HTTP runs (real server, scratch data folder; your `./data` was never touched)

| Run | Result |
|---|---|
| Dev server, `AUTH_MFA_REQUIRED=false`: platform and owner login, dashboard, cross-access | pass (earlier task) |
| Production config with `AUTH_MFA_REQUIRED=false` | refused to start, exit 78 (correct) |
| `.env` validated against the production rules (values not printed) | pass after fix A-02 |
| **Field simulator**: 2 simulated phones on the real mobile sync engine, 2 minutes, connectivity toggled every 3 cycles, SOS while offline | **pass** after fix A-04. The device was approved by a commander through the real workflow; duty start was accepted; points were buffered offline and flushed; the SOS was queued offline then delivered; duty end left the queue empty. Server side, the SOS incident exists and the live view shows the officer in **SOS**, freshness **live**, with the battery value the phone sent. |
| First simulator attempt (before the fix) | **failed**: `DEVICE_NOT_APPROVED`. Root cause in A-04. |
| Load test `npm run load` (in-process, memory store, 1,000 staff) | live view p50 15.5 ms / p95 25.5 ms; dashboard p50 10.7 ms / p95 15.4 ms. **Not representative of production** (no network, TLS or MongoDB). |

## 5. GPS verification

| Check | Result |
|---|---|
| Server pipeline: signed batch ingestion, replay dedupe, out-of-order handling, quality flags, freshness live → recent → stale, purpose-gated audited history, scope and tenant isolation | **PASS** (journeys J3/J5, locations tests, browser steps 5–6, simulator over HTTP). Uses synthetic coordinates. |
| Browser **denied** permission is reported as an error, never as a position | **PASS** (`tests/e2e-web/gps-browser.ts`) |
| Real location fix from Chrome with permission **granted** | **BLOCKED**: Windows location services are set to **Deny**, so Chrome returns "User denied Geolocation". Re-run after enabling location (command in `PRODUCTION_DEPENDENCIES.md` §5). |
| Real phone capture (Expo app: foreground/background tracking, permission onboarding) | **BLOCKED**: the app has never been built; needs an Android/iOS device |

**GPS on a real device has not been verified.** No live location shown during testing was presented as a real person's position.

## 6. Known failing item
- **Recovery codes are not shown to users after MFA set-up** (audit A-07). Recovery-code *verification* works (MFA tests). Not fixed, because MFA was out of scope for this task.
