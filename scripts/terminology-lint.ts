// FR-NFR-005 / PRD §10: product copy must not use surveillance or overclaiming language.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DICTS, FORBIDDEN_TERMS } from '@sf/i18n';
const hits: string[] = [];
for (const [loc, d] of Object.entries(DICTS)) for (const [k, v] of Object.entries(d)) for (const term of FORBIDDEN_TERMS) if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(v)) hits.push(`i18n ${loc}.${k}: "${term}"`);
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? (f === 'node_modules' || f === 'dist' ? [] : walk(p)) : /\.(tsx?|json)$/.test(f) ? [p] : []; });
for (const file of [...walk('apps/web/src'), ...walk('apps/mobile/src'), ...walk('modules')]) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/(['"`])((?:(?!\1).){12,300})\1/g)) for (const term of FORBIDDEN_TERMS) if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(m[2]!) && /\s/.test(m[2]!)) hits.push(`${file}: "${term}" in ${m[2]!.slice(0, 60)}`);
}
// Every English key must exist in Arabic and vice versa.
const en = Object.keys(DICTS.en), ar = new Set(Object.keys(DICTS.ar));
for (const k of en) if (!ar.has(k)) hits.push(`missing Arabic string: ${k}`);
for (const k of ar) if (!(k in DICTS.en)) hits.push(`missing English string: ${k}`);
if (hits.length) { console.error(hits.join('\n')); process.exit(1); }
console.log(`terminology lint ok (${en.length} keys in EN and AR, ${FORBIDDEN_TERMS.length} forbidden terms checked)`);
