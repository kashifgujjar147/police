# Runbook: load and capacity testing

## In-process test (included, run in CI)
```bash
npm run load -- --staff 300 --batches 3000 --states 1000
```
Measures the application code path with the memory store: location batch ingestion (10 points per batch, signed by a device key), `/locations/latest` with 1,000 latest states, and the dashboard. Last result (build environment, single process): 300 staff, 30,000 points accepted at ~1,570 points/s, ingest batch p95 10.7 ms, `/locations/latest` p95 5.9 ms, dashboard p95 3.1 ms. **This does not include network, TLS, MongoDB or the realtime fan-out to browsers.**

## Real-stack test (required before go-live — FR-NFR-007)
Target from D-11: 1,000 on-duty staff per tenant at 30 s sampling ≈ 33 points/s per tenant; test at 3× (100 points/s per tenant, 10 tenants) for 1 hour.

1. Deploy the production Compose stack on hardware equal to production.
2. Seed tenants: `DEMO_SLUG=<slug> SEED_STAFF=480 npm run seed:demo` per tenant (non-production only; the demo uses the Professional plan, 500 staff — raise the plan in the platform console for 1,000) (or provision via the platform console).
3. Run several simulators in parallel from other machines:
   `npm run simulate -- --url https://host --tenant <slug> --users sim-1,sim-2 --minutes 60 --offline-every 10`
   (create more `sim-*` officers in the demo builder for larger runs.)
4. Open 50 command-centre browser sessions (or SSE clients with `curl -N`) per tenant.
5. Watch `/metrics`: `sf_http_latency_ms` p95 per rate class, `sf_location_ingest_lag_ms`, `sf_job_lateness_ms`, `sf_realtime_fanout_ms`, `sf_sos_accept_to_notify_ms`.

Pass criteria (PRD §12): live map update ≤ 5 s p95 from receipt; SOS notification ≤ 5 s p95; API p95 ≤ 500 ms for reads, ≤ 1 s for writes; no job lateness above 60 s; zero lost points (compare simulator sent vs `location_points` count).
