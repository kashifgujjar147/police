// npm run trace — checks docs/RTM.md: every PRD requirement ID appears exactly once with a known status,
// and every cited test exists (file + fragment of the test name). Prints a status summary.
import { existsSync, readFileSync } from 'node:fs';
const PRD_IDS = `FR-A11Y-001 FR-A11Y-002 FR-A11Y-003 FR-ALR-001 FR-ALR-002 FR-ALR-003 FR-ALR-004 FR-ALR-005 FR-ATT-001 FR-ATT-002 FR-ATT-003 FR-ATT-004 FR-ATT-005 FR-ATT-006 FR-ATT-007 FR-AUD-001 FR-AUD-002 FR-AUD-003 FR-AUTH-001 FR-AUTH-002 FR-AUTH-003 FR-AUTH-004 FR-AUTH-005 FR-AUTH-006 FR-AUTH-007 FR-AUTH-008 FR-AUTH-009 FR-CHK-001 FR-CHK-002 FR-CHK-003 FR-CHK-004 FR-CHK-005 FR-CMD-001 FR-CMD-002 FR-CMD-003 FR-CMD-004 FR-CMD-005 FR-CMD-006 FR-CMD-007 FR-DEV-001 FR-DEV-002 FR-DEV-003 FR-DEV-004 FR-DEV-005 FR-DUTY-001 FR-DUTY-002 FR-DUTY-003 FR-DUTY-004 FR-DUTY-005 FR-DUTY-006 FR-DUTY-007 FR-DUTY-008 FR-ENT-001 FR-ENT-002 FR-ENT-003 FR-EXP-001 FR-EXP-002 FR-GEO-001 FR-GEO-002 FR-GEO-003 FR-I18N-001 FR-I18N-002 FR-I18N-003 FR-I18N-004 FR-INC-001 FR-INC-002 FR-INC-003 FR-INC-004 FR-LOC-001 FR-LOC-002 FR-LOC-003 FR-LOC-004 FR-LOC-005 FR-LOC-006 FR-LOC-007 FR-LOC-008 FR-MOB-001 FR-MOB-002 FR-MOB-003 FR-MOB-004 FR-MOB-005 FR-MOB-006 FR-MOB-007 FR-MOB-008 FR-NFR-001 FR-NFR-002 FR-NFR-003 FR-NFR-004 FR-NFR-005 FR-NFR-006 FR-NFR-007 FR-ORG-001 FR-ORG-002 FR-ORG-003 FR-ORG-004 FR-ORG-005 FR-ORG-006 FR-ORG-007 FR-ORG-008 FR-PRV-001 FR-PRV-002 FR-PRV-003 FR-PRV-004 FR-PRV-005 FR-PRV-006 FR-RBAC-001 FR-RBAC-002 FR-RBAC-003 FR-RBAC-004 FR-RBAC-005 FR-RPT-001 FR-RPT-002 FR-RPT-003 FR-RPT-004 FR-RPT-005 FR-SET-001 FR-SET-002 FR-SET-003 FR-SET-004 FR-SOS-001 FR-SOS-002 FR-SOS-003 FR-SOS-004 FR-SOS-005 FR-SOS-006 FR-SUB-001 FR-SUB-002 FR-SUB-003 FR-SUB-004 FR-SUP-001 FR-SYN-001 FR-SYN-002 FR-SYN-003 FR-TEN-001 FR-TEN-002 FR-TEN-003 FR-TEN-004 FR-TEN-005`.split(/\s+/);
const FILES: Record<string, string> = { U: 'tests/unit/domain.test.ts', M: 'tests/unit/mobile-core.test.ts', J: 'tests/integration/journeys.test.ts', S: 'tests/integration/security.test.ts', O: 'tests/integration/operations.test.ts', H: 'tests/integration/http.test.ts', W: 'tests/e2e-web/run.ts', L: 'tests/load/ingest-load.ts' };
const STATUSES = ['Verified', 'Verified (browser)', 'Implemented', 'Partial', 'Unverified (device)', 'Not implemented'];
const rows = readFileSync('docs/RTM.md', 'utf8').split('\n').filter((l) => /^\| (FR|TR)-/.test(l)).map((l) => l.split('|').map((c) => c.trim()));
const errs: string[] = []; const seen = new Map<string, number>(); const tally: Record<string, number> = {}; const mvp: Record<string, number> = {};
for (const r of rows) {
  const [, id, , pri, status, evidence] = r as [string, string, string, string, string, string];
  seen.set(id, (seen.get(id) ?? 0) + 1); if (!STATUSES.includes(status)) errs.push(`${id}: unknown status "${status}"`);
  tally[status] = (tally[status] ?? 0) + 1; if (pri.includes('MVP')) mvp[status] = (mvp[status] ?? 0) + 1;
  if (status.startsWith('Verified') && (!evidence || evidence === '—')) errs.push(`${id}: Verified without evidence`);
  for (const ev of evidence.split(';').map((x) => x.trim()).filter((x) => x && x !== '—')) {
    const m = /^([A-Z]) :: (.+)$/.exec(ev); if (!m || !FILES[m[1]!]) { errs.push(`${id}: bad evidence "${ev}"`); continue; }
    const file = FILES[m[1]!]!; if (!existsSync(file) || !readFileSync(file, 'utf8').includes(m[2]!)) errs.push(`${id}: "${m[2]}" not found in ${file}`);
  }
}
for (const id of PRD_IDS) if (seen.get(id) !== 1) errs.push(`${id}: appears ${seen.get(id) ?? 0} times`);
for (const id of seen.keys()) if (!PRD_IDS.includes(id)) errs.push(`${id}: not a PRD requirement`);
if (errs.length) { console.error(errs.join('\n')); process.exit(1); }
console.log(`trace ok: ${PRD_IDS.length} PRD requirements traced.`); console.log('All   :', JSON.stringify(tally)); console.log('MVP   :', JSON.stringify(mvp));
