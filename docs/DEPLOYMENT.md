# Installation and deployment

## 1. Development (single machine)

```bash
node --version                 # must be 22 or newer
npm install
npm run build:web
npm run seed:demo              # optional demo organisation (fictional data)
npm start                      # http://localhost:8080 — API + web + worker in one process
```

Development defaults: `STORE=file` (data in `./data/smartforce360.db.json`, files in `./data/files`), secrets generated once into `./data/dev-secrets.json`, email written to an in-memory outbox (no SMTP). Run `npm run dev` for the same with `NODE_ENV=development`. Web changes need `npm run build:web` (or `NODE_ENV=development npm run build:web` for an unminified bundle).

To create your own organisation instead of the demo, set `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` before the first start, open **Platform staff sign-in** on the login page, enrol MFA, and use **Provision organisation**. The Owner activation code is shown once.

The **file store is single-process only**: do not run two API processes against the same `DATA_DIR`, and do not delete `DATA_DIR` while a server is running (the server writes its in-memory state back on shutdown).

## 2. Production

### Requirements
- MongoDB 7 **replica set** (transactions are required). A single-member replica set is fine for small pilots.
- A reverse proxy with TLS (the Compose file uses Caddy with free Let's Encrypt certificates). Server-sent events must not be buffered.
- Persistent storage for uploaded files and exports (`DATA_DIR/files`). For multiple API instances, mount shared storage or add an S3-compatible adapter behind `FileStorage` (`modules/records/index.ts`).
- Optional: an SMTP relay for email. In-app notifications work without it.

### Configure
```bash
cp .env.example .env
npm run secrets                # prints JWT_KEYS_JSON, JWT_ACTIVE_KID, FIELD_ENC_KEY, JOB_HMAC_KEY, FILE_URL_KEY, METRICS_TOKEN
```
Put the values in `.env` (or your secret manager), set `PUBLIC_URL` (https), `CORS_ORIGINS`, `MONGO_URL`, `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD`. The service **refuses to start** in production when a secret is missing or weak, `PUBLIC_URL` is not https, `STORE` is not `mongo`, or `DEMO_MODE=true`.

### Run with Docker Compose
```bash
# edit infrastructure/docker/Caddyfile: replace smartforce.example.org with your host name
docker compose -f infrastructure/docker/docker-compose.yml up -d --build
docker compose -f infrastructure/docker/docker-compose.yml logs -f api worker
```
Services: `mongo` (initiates the replica set itself), `api` (with `WORKER_IN_PROCESS=false`), `worker`, `proxy` (Caddy). Add `--profile dev` to start Mailpit for test email (`SMTP_HOST=mailpit`, `SMTP_PORT=1025`, UI on :8025).

Indexes are created idempotently on start (`MongoStore.ensureIndexes`) from the schema inventory; the run is recorded in `migration_log`.

### Run without Docker
```bash
npm install && npm run build:web      # commit the generated package-lock.json, then use npm ci
NODE_ENV=production npx tsx apps/api/src/main.ts      # API (several instances behind the proxy are fine with MongoDB)
NODE_ENV=production npx tsx apps/worker/src/main.ts   # one or more workers
```
Use systemd or another supervisor with restart on failure. `SIGTERM` drains in-flight work and closes the store.

### Health and monitoring
- `GET /health/live` — process is up. `GET /health/ready` — database reachable, queue depth, dead jobs (503 when not ready).
- `GET /metrics` with `Authorization: Bearer $METRICS_TOKEN` — Prometheus text: request counts and latency by rate class, job outcomes and lateness, realtime fan-out, location ingest lag, SOS accept-to-notify time, audit verification results.
- Logs are JSON lines on stdout with request id, route, status, duration, tenant and actor ids. Passwords, tokens, codes and coordinates are redacted (tested).

### Backups and restore
`infrastructure/backup/backup.sh` (every 15 min via cron) and `restore.sh`. After a restore drill run `npm run verify:restore` to verify every tenant's audit chain. See `docs/runbooks/backup-restore.md`. Encrypt backups before they leave the host.

### Upgrades
1. Back up. 2. Deploy the new image to the worker first, then the API (rolling). 3. Indexes are additive and created on start. 4. Raise `devices.minAppVersion` in tenant settings only after the new app is in users' hands (SOS keeps working below the minimum).

### Key rotation
Add a new key to `JWT_KEYS_JSON`, switch `JWT_ACTIVE_KID`, restart; remove the old key after 15 minutes. `FIELD_ENC_KEY` rotation needs a re-encryption job (not included; see FINAL_REPORT.md).

## 3. Mobile app
See `docs/MOBILE.md`. The app is configured with the API base URL on the sign-in screen (default from `app.json` → `extra.apiBaseUrl`).

## 4. Running the tests
```bash
npm run verify                 # everything that runs without external services
npx playwright install chromium && npm run build:web && npm run test:e2e:web
MONGO_URL="mongodb://localhost:27017/?replicaSet=rs0" npm run test:mongo
```
