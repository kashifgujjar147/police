# Multi-stage build. ONE service: the API also serves the built web portal (same origin, no separate frontend).
# Used by Railway (railway.json) and docker compose. Runs as an unprivileged user.
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY . .
RUN npm run build:web && npm run typecheck

FROM node:22-bookworm-slim
# Railway injects PORT; WORKER_IN_PROCESS=true runs alerts/escalation/exports inside the same service.
# TRUST_PROXY=true because the app always sits behind a proxy (Railway edge or Caddy) — real client IPs for rate limits.
ENV NODE_ENV=production AUTH_MFA_REQUIRED=true PORT=8080 HOST=0.0.0.0 WEB_DIR=/app/apps/web/dist \
    DATA_DIR=/var/lib/smartforce360 WORKER_IN_PROCESS=true TRUST_PROXY=true
WORKDIR /app
COPY --from=build /app /app
RUN useradd --system --uid 10001 sf && mkdir -p /var/lib/smartforce360 && chown -R sf /var/lib/smartforce360
USER sf
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# node directly (not npx) so SIGTERM reaches the app and it shuts down gracefully on redeploys
CMD ["node", "--import", "tsx", "apps/api/src/main.ts"]
