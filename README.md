# SmartForce 360

Field-force duty accountability for organisations with staff at fixed posts and on patrol: rosters, duty start and end, location while on duty only, geofences, checkpoints, alerts, SOS, incidents, reports and an audit trail. Multi-tenant, English and Arabic (right-to-left).

Built from PRD v2.1, Technical Specification v2.1 and the Master Development Prompt v2.1. **Read `FINAL_REPORT.md` first** — it states exactly what is verified, what is only written, and what still needs external setup.

| Part | Where | State |
|---|---|---|
| API, worker, realtime (Node 22, TypeScript) | `apps/api`, `apps/worker`, `modules/*` | Built and tested (58 automated tests) |
| Web portal and command centre (React) | `apps/web` | Built; 15 browser checks in Chrome |
| Mobile sync engine, offline queue, SOS logic | `packages/mobile-core` | Built and tested against the real API |
| Field app (Expo / React Native) | `apps/mobile` | **Source only — not compiled or device-tested** |
| MongoDB adapter | `modules/kernel/mongo-store.ts` | **Written, not run** (no MongoDB in the build environment) |

## Quick start (no Docker, no database)

Requires **Node.js 22+** and npm.

```bash
npm install                 # installs TypeScript, tsx, esbuild, React (+ mongodb driver, optional)
npm run build:web           # builds the web portal into apps/web/dist
npm run seed:demo           # creates a fictional "demo" organisation in ./data and prints sign-in details
npm start                   # API + web + worker on http://localhost:8080
```

Open http://localhost:8080 and sign in:

| Organisation ID | Username | Password | Notes |
|---|---|---|---|
| `demo` | `cmd-01` | `Demo-Passphrase-2026!` | Commander — sees the command centre, alerts, SOS |
| `demo` | `sup-01`, `dsp-01`, `aud-01` | same | Supervisor, dispatcher, auditor |
| `demo` | `fo-001` … `fo-014` | same | Field officers (web "My data"; their duties run on the phone) |
| `demo` | `owner` | same | Needs MFA: add the TOTP key printed by `seed:demo` to an authenticator app |

The demo data is clearly labelled and refused in production. To reset it: stop the server, delete `./data`, run `npm run seed:demo` again.

Drive simulated phones against the running server (same sync engine as the app):

```bash
npm run simulate -- --url http://localhost:8080 --users sim-1,sim-2 --minutes 5 --offline-every 4 --sos sim-2
```

## Everyday commands

| Command | What it does |
|---|---|
| `npm run verify` | Type-check, terminology and architecture lints, all tests, web build, OpenAPI, traceability check |
| `npm test` | 58 unit, integration, security and journey tests (in-memory store, fake clock) |
| `npm run test:e2e:web` | Playwright run of the built portal in Chrome (`npx playwright install chromium` first, or set `CHROME_PATH`) |
| `npm run test:mongo` | The journey suite against MongoDB (`MONGO_URL` to a replica set) |
| `npm run load` | In-process load test (ingestion and live-map latency) |
| `npm run seed:demo` | Demo organisation |
| `npm run secrets` | Fresh production secrets for `.env` |
| `npm run openapi` / `npm run matrix` / `npm run trace` | Regenerate API spec, permission matrix, RTM check |
| `npm run worker` | Separate worker process (MongoDB deployments) |

## Production

Use MongoDB (replica set), HTTPS and a separate worker. Full instructions: **`docs/DEPLOYMENT.md`**.

```bash
cp .env.example .env && npm run secrets      # paste the printed values into .env
docker compose -f infrastructure/docker/docker-compose.yml up -d --build
```

## Repository map

```
apps/api            HTTP server, composition root
apps/worker         worker process (outbox relay, job queue, schedulers)
apps/web            React web portal (command centre, planner, admin, platform console)
apps/mobile         Expo field app (source)
modules/            kernel (HTTP pipeline, store, events, crypto) + one folder per domain module
packages/           contracts (validation, states, defaults), permissions, domain (pure rules), i18n, mobile-core, config
tests/              unit, integration (journeys, security, operations, HTTP), e2e-web (Playwright), load
infrastructure/     Dockerfile, Compose, Caddy, backup/restore scripts
docs/               architecture, deployment, security, decisions, RTM, OpenAPI, test results, runbooks
tools/              field simulator
```

## Documentation

`FINAL_REPORT.md` · `docs/ARCHITECTURE.md` · `docs/DEPLOYMENT.md` · `docs/SECURITY_MODEL.md` · `docs/DECISIONS_AND_ASSUMPTIONS.md` · `docs/RTM.md` · `docs/MOBILE.md` · `docs/ROLE_PERMISSION_MATRIX.md` · `docs/openapi.json` · `docs/TEST_RESULTS.md` · `docs/runbooks/`

No paid services are used or required. Email is plain SMTP to a relay you control; map tiles are optional and configured per tenant; no push or SMS provider is bundled.
