# Test results

Run on 2026-11-12 in the build environment (Linux, Node 22.23, no network, no MongoDB, no mobile devices). Raw output is in `docs/test-results/`.

| # | Check | Command | Result |
|---|---|---|---|
| 1 | Type check (server, packages, tests, scripts) | `npm run typecheck` | **Pass** |
| 1 | Type check (web, with a local React type shim — `@types/react` not installable offline) | `npm run typecheck:web:offline` | **Pass** |
| 1 | Terminology lint (461 keys EN = AR, 17 forbidden terms) | `npm run lint:terms` | **Pass** |
| 1 | Architecture boundary lint | `npm run lint:boundaries` | **Pass** |
| 2 | Unit, integration, security, journey, HTTP and mobile-core tests | `npm test` | **58 / 58 pass**, 0 fail, ~6 s |
| 3 | Web production build | `npm run build:web` | **Pass** |
| 4 | Browser end-to-end (Playwright + Chrome, real HTTP server, file store, demo data) | `npm run test:e2e:web` | **15 / 15 pass**; screenshots in `tests/e2e-web/screenshots` |
| 5 | Requirement traceability (every PRD requirement in the RTM; every "Verified" row points to a passing test) | `npm run trace` | **Pass** — 138 requirements |
| 6 | Load (in-process, memory store) | `npm run load` | 300 staff, 30,000 points, ~1,570 points/s; ingest batch p95 10.7 ms; live map (1,000 states) p95 5.9 ms; dashboard p95 3.1 ms |
| 7 | Field simulator over real HTTP (2 simulated phones, network drops, SOS) | `npm run simulate` | Ran: duties started, points and scans synced after drops, SOS delivered first |
| 8 | Restore verification against a seeded file store | `npm run verify:restore` | Audit chain OK |

## Automated tests (58)

**Journeys (PRD §8):** J1 provision and onboard · J2 plan and publish · J3 work a duty · J4 offline duty · J5 supervise live · J6 exception alert with escalation · J7 SOS · J8 attendance correction · J9 review and report · J10 offboard, export and deletion.

**Security:** cross-tenant access on every route (TR-001) · schema inventory · route metadata · permission matrix for all 7 roles (TR-002) · lockout and password policy · MFA · session rotation and reuse detection · device binding and revocation · audit chain and tamper detection · log hygiene.

**Operations:** hierarchy scope · unit move/merge · staff import · DST-safe planning and overlap policy · duty start gates · location validation and history purpose · geofence hysteresis · checkpoints · settings and API conventions · platform console and support grants · job durability across a worker restart · retention and file uploads · rate limits (SOS exempt) · notifications and catalogues · HTTP adapter (health, metrics, CORS, headers, SSE).

**Unit:** geometry, geofence uncertainty, polygon validation, noisy tracks, DST recurrence, freshness, start window, display classification, scan reasons, rotating tokens, CSV safety, hash chain, TOTP RFC vector, backoff and thinning, review signals, state machines, validation.

**Mobile core:** offline queue across restart, SOS ordering and honesty, sampler and key conversion.

## Not tested here
| Item | Why | How to test |
|---|---|---|
| MongoDB store (`npm run test:mongo`) | No MongoDB available | Run the journey suite against a replica set |
| Expo app on Android/iOS | No SDK, no devices | `docs/MOBILE.md` device checklist |
| Web type check with real `@types/react` (`npm run typecheck:web`) | Package not installable offline | Runs in CI |
| `npm audit`, container scan | No registry access | CI workflow |
| Accessibility audit (axe-core, screen reader) | Not available | Run axe in Playwright; manual audit |
| Real-stack capacity at 3× target | Needs deployed stack | `docs/runbooks/load-test.md` |
| Backup/restore drill with MongoDB | No MongoDB | `docs/runbooks/backup-restore.md` |
| SMTP delivery | No relay | Mailpit profile in Compose |
| Argon2id hashing | Native module not installable | `npm i argon2`, `PASSWORD_ALGO=argon2id`, rerun tests |
