// npm run matrix — writes docs/ROLE_PERMISSION_MATRIX.md from the permission source of truth.
import { writeFileSync } from 'node:fs';
import { PERMISSION_GRANTS, PERMISSION_KEYS, ROLE_KEYS, ROLE_NAMES } from '@sf/permissions';
const head = `| Permission key | ${ROLE_KEYS.map((r) => ROLE_NAMES[r].en).join(' | ')} |\n|---|${ROLE_KEYS.map(() => ':-:').join('|')}|`;
const rows = PERMISSION_KEYS.map((k) => `| \`${k}\` | ${ROLE_KEYS.map((r) => (PERMISSION_GRANTS[k]!.includes(r) ? '✓' : '')).join(' | ')} |`);
writeFileSync('docs/ROLE_PERMISSION_MATRIX.md', `# Default role permission matrix\n\nGenerated from \`packages/permissions/src/index.ts\` (\`npm run matrix\`). Source: PRD Appendix A. Scope (whole organisation or assigned units and their descendants) is applied on top of these keys; field staff act only on their own records. Platform staff hold no tenant keys; tenant content needs an approved support grant.\n\n${head}\n${rows.join('\n')}\n`);
console.log(`matrix: ${PERMISSION_KEYS.length} keys × ${ROLE_KEYS.length} roles`);
