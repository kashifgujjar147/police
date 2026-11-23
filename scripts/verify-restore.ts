// npm run verify:restore — after a restore drill: verifies every tenant's audit hash chain and prints record counts.
import { loadConfig } from '@sf/config';
import { createApp } from '../apps/api/src/app.ts';
const app = await createApp({ config: { ...loadConfig(), runWorkerInProcess: false, logLevel: 'warn' } });
let ok = true;
for (const t of await app.store.find('tenants', { status: { $ne: 'deleted' } })) {
  const ctx = app.systemCtx(t, 'verify-restore'); const r = await app.services.verifyAudit(ctx); const counts = await app.services.retention.tenantCounts(ctx);
  ok &&= r.ok; console.log(`${t.slug}: audit ${r.ok ? `ok (${r.count})` : `BROKEN at ${r.brokenAtSeq}`}; staff=${counts.staff_members ?? 0} assignments=${counts.duty_assignments ?? 0} incidents=${counts.incidents ?? 0}`);
}
await app.store.close(); process.exit(ok ? 0 : 1);
