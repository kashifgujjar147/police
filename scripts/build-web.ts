// Builds the web portal with esbuild into apps/web/dist (one JS bundle + CSS + index.html).
import { build } from 'esbuild';
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..'); const web = join(root, 'apps/web'); const out = join(web, 'dist');
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
const r = await build({
  entryPoints: [join(web, 'src/main.tsx')], bundle: true, outfile: join(out, 'app.js'), format: 'esm', target: ['es2022', 'chrome110', 'firefox110', 'safari16'],
  minify: process.env.NODE_ENV !== 'development', sourcemap: true, jsx: 'automatic', metafile: true, legalComments: 'none',
  alias: { '@sf/i18n': join(root, 'packages/i18n/src/index.ts'), '@sf/contracts': join(root, 'packages/contracts/src/index.ts'), '@sf/domain': join(root, 'packages/domain/src/index.ts') },
  define: { 'process.env.NODE_ENV': '"production"' }, nodePaths: [join(root, 'node_modules')], logLevel: 'warning',
});
await build({ entryPoints: [join(web, 'src/styles.css')], bundle: true, minify: true, outfile: join(out, 'app.css'), logLevel: 'warning' });
copyFileSync(join(web, 'index.html'), join(out, 'index.html'));
if (existsSync(join(web, 'public'))) cpSync(join(web, 'public'), out, { recursive: true }); // PWA: manifest, service worker, icons
const bytes = Object.values(r.metafile!.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`web build ok → apps/web/dist (${Math.round(bytes / 1024)} KiB incl. source map)`);
