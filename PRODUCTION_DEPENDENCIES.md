# SmartForce 360 — Production Dependencies

**Date:** 2026-11-13. These are what the code needs from outside before it can run in production. Nothing listed as "missing" here has been tested against a real service.

## 1. Infrastructure (required)

| Need | Why | Status |
|---|---|---|
| **MongoDB 7 replica set** (transactions need a replica set) | Production store (`STORE=mongo` is enforced in production) | **Missing / never run.** Run `npm run test:mongo` against it first. |
| **Host with Docker + Docker Compose** | `infrastructure/docker/docker-compose.yml`: mongo, api, worker, Caddy | Not available on this machine |
| **Public domain + DNS** pointing at the host | Caddy gets TLS certificates automatically | Missing. `PUBLIC_URL` must be `https://…` |
| **HTTPS** | Required in production by config; browsers and phones also need it for geolocation | Provided by Caddy once the domain exists |
| **Persistent volumes + off-site backups** | `mongo-data`, `files` volumes; `infrastructure/backup/backup.sh` | Scripts exist; no drill done |
| **Separate worker process** | Compose runs `apps/worker` (`WORKER_IN_PROCESS=false`) | Configured |

## 2. External services

| Service | Used for | Configure | Status |
|---|---|---|---|
| **SMTP relay** (any provider) | Email notifications and password-reset mail. In-app notifications work without it. | `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` | **Missing**: `SMTP_HOST` is empty |
| **Map tile server** (e.g. a MapTiler/Stadia key, or self-hosted tiles; the public OpenStreetMap servers do not allow production traffic) | Street map behind live positions. Without it the map uses a plain grid. | Per organisation: **Settings › Map › tile URL and attribution** (`map.tileUrl`, `map.attribution`) | **Missing** |
| **Push provider** (e.g. Firebase Cloud Messaging) | Phone alerts while the app is closed | Needs an account **and code**; no adapter exists (FR-MOB-008) | **Not implemented** |
| **SMS provider** (optional) | SMS alerts | Needs an account and code | **Not implemented** |
| **Expo / EAS account + Android/iOS signing** | Building the field app | `apps/mobile` (`npm run build:android:local`) | **Missing**; app never built |
| **Error monitoring** (optional, e.g. Sentry) | Alerting on server errors | Not wired; JSON logs and `/metrics` (Prometheus, `METRICS_TOKEN`) exist | Optional |

## 3. Environment variables (production)

The service refuses to start if a required value is missing or unsafe (`packages/config/src/index.ts`). Generate secrets with `npm run secrets` and keep them in a secret manager, not in Git.

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV=production` | yes | |
| `PUBLIC_URL` | yes | must start with `https://` |
| `CORS_ORIGINS` | yes | the web origin(s) |
| `STORE=mongo`, `MONGO_URL`, `MONGO_DB` | yes | replica-set URL |
| `JWT_KEYS_JSON`, `JWT_ACTIVE_KID` | yes | from `npm run secrets` |
| `FIELD_ENC_KEY` (32 bytes base64), `JOB_HMAC_KEY`, `FILE_URL_KEY` (≥32 chars) | yes | from `npm run secrets` |
| `METRICS_TOKEN` | recommended | protects `/metrics` |
| `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD` (≥12 chars) | first start | creates the Super Admin, who must set up MFA at first sign-in. Remove after first start. |
| `AUTH_MFA_REQUIRED=true` | yes | `false` is **refused** in production. Dev bypass: `npm run dev:no-mfa` only |
| `DEMO_MODE=false` | yes | `true` is refused in production |
| `TRUST_PROXY=true` | behind Caddy | |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` | for email | |
| `PASSWORD_ALGO`, `SCRYPT_N`, `SCRYPT_P` | optional | `argon2id` needs the optional `argon2` package |
| `RATE_LIMITS=on`, `LOG_LEVEL=info` | defaults | |

**Your current `.env`:** checked on 2026-11-13 without printing any values. It **passes** production validation now that `AUTH_MFA_REQUIRED=true` is set. `SMTP_HOST` is empty, so there will be no email.

## 4. Deployment steps
1. Provision the host, DNS and volumes. Copy `.env` there (never into Git) and confirm `PUBLIC_URL`/`CORS_ORIGINS` match the domain.
2. `docker compose -f infrastructure/docker/docker-compose.yml up -d --build`
3. Check `GET /health/ready` and Platform › Health.
4. Sign in as Super Admin, set up MFA, then remove `PLATFORM_ADMIN_PASSWORD` from the environment.
5. Run `npm run test:mongo` (in CI or on staging) and a backup → restore → `npm run verify:restore` drill.
6. Set each organisation's map tile URL. Build and distribute the field app.
7. Load-test against staging (`docs/runbooks/load-test.md`).

## 5. Local testing (for reference)
- `npm run dev:no-mfa`: password-only admin login, development only.
- `npm run dev`: normal MFA.
- Real-GPS check: turn on **Windows Settings › Privacy & security › Location** (and "Let desktop apps access your location"), then run `CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" npx tsx tests/e2e-web/gps-browser.ts`.
