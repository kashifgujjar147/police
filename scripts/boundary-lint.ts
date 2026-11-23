// Architecture boundaries (TS §5): modules reach tenant data only through scoped repositories; web/mobile never import server code;
// browser-safe packages never import Node built-ins.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { COLLECTIONS } from '@sf/kernel';
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? (f === 'node_modules' || f === 'dist' ? [] : walk(p)) : /\.tsx?$/.test(f) ? [p] : []; });
const errs: string[] = [];
// 1. Direct store access to a tenant-owned collection must carry an explicit tenantId (system jobs / deletion) — never an unscoped query.
for (const f of walk('modules').filter((f) => !f.replaceAll('\\', '/').includes('kernel/'))) { // normalise Windows separators
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((ln, i) => { for (const m of ln.matchAll(/store\.(find|findOne|count|updateOne|updateMany|deleteMany|insert)\('(\w+)'(.{0,200})/g)) { const def = COLLECTIONS[m[2]!]; if (def?.tenantOwned && !/tenantId/.test(m[3]!) && !(m[2] === 'counters')) errs.push(`${f}:${i + 1} unscoped store.${m[1]}('${m[2]}')`); } });
}
// 2. Client apps never import server modules.
for (const f of [...walk('apps/web/src'), ...walk('apps/mobile/src')]) { const t = readFileSync(f, 'utf8'); if (/from ['"](@sf\/kernel|@sf\/config|.*modules\/|node:)/.test(t)) errs.push(`${f}: client code imports server-only code`); }
// 3. Browser-safe shared packages stay free of Node built-ins.
for (const f of [...walk('packages/domain/src').filter((x) => !x.endsWith('node.ts')), ...walk('packages/contracts/src'), ...walk('packages/i18n/src'), ...walk('packages/mobile-core/src').filter((x) => !x.endsWith('node.ts'))]) if (/from ['"]node:/.test(readFileSync(f, 'utf8'))) errs.push(`${f}: imports a Node built-in`);
// 4. Modules do not import each other's internals except through their index.
for (const f of walk('modules')) for (const m of readFileSync(f, 'utf8').matchAll(/from '\.\.\/(\w+)\/([\w.-]+)'/g)) if (!['index.ts', 'provision.ts'].includes(m[2]!)) errs.push(`${f}: imports ${m[1]}/${m[2]} (use the module index)`);
if (errs.length) { console.error(errs.join('\n')); process.exit(1); }
console.log('boundary lint ok');
