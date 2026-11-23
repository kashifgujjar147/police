// Node HTTP adapter: request parsing, CORS allow-list, static web app, health and metrics endpoints, SSE streaming.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { type App, type Req, safeEqual, securityHeaders } from '@sf/kernel';

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json', '.webmanifest': 'application/manifest+json' };
const WEB_CSP = "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > limit) { res(null); req.destroy(); } else chunks.push(c); });
    req.on('end', () => res(Buffer.concat(chunks))); req.on('error', rej);
  });
}

export function startServer(app: App): Promise<Server> {
  const cfg = app.config; const webRoot = resolve(cfg.webDir); const trustProxy = process.env.TRUST_PROXY === 'true';
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://local'); const path = url.pathname; const method = (req.method ?? 'GET').toUpperCase();
      const origin = req.headers.origin; const cors: Record<string, string> = {};
      if (origin && cfg.corsOrigins.includes(origin)) Object.assign(cors, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin', 'Access-Control-Expose-Headers': 'X-Request-Id, Retry-After, Idempotent-Replay' });
      if (method === 'OPTIONS') { res.writeHead(origin && cfg.corsOrigins.includes(origin) ? 204 : 403, { ...cors, 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key, If-Match, X-CSRF-Token, X-Device-Timestamp, X-Device-Signature, X-App-Version, X-Support-Grant, X-Support-Tenant', 'Access-Control-Max-Age': '600' }); res.end(); return; }

      if (path === '/health/live') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{"status":"ok"}'); return; }
      if (path === '/health/ready') { // readiness reports real dependency state (TS §23)
        const store = await app.store.ready(); const q = await app.jobs.stats();
        res.writeHead(store.ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ status: store.ok ? 'ready' : 'not_ready', store: store.ok ? 'ok' : 'unavailable', queueDue: q.due, deadJobs: q.dead })); return;
      }
      if (path === '/metrics') {
        const tok = (req.headers.authorization ?? '').replace(/^Bearer /, '');
        if (!cfg.metricsToken || !safeEqual(tok, cfg.metricsToken)) { res.writeHead(cfg.metricsToken ? 401 : 404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' }); res.end(app.metrics.render()); return;
      }

      if (path.startsWith('/api/')) {
        const buf = await readBody(req, 11 * 1024 * 1024);
        if (buf === null) { res.writeHead(413, { 'Content-Type': 'application/json', ...securityHeaders(cfg), ...cors }); res.end(JSON.stringify({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' } })); return; }
        const headers: Record<string, string> = {}; for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
        const ip = (trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]!.trim() : '') || req.socket.remoteAddress || '';
        const isBinary = method === 'PUT' && /^\/api\/v1\/files\/[^/]+\/content$/.test(path);
        const r: Req = { method, path, query: Object.fromEntries(url.searchParams), headers, rawBody: isBinary ? '' : buf.toString('utf8'), rawBuffer: isBinary ? buf : undefined, ip };
        const out = await app.handle(r);
        if (out.stream) {
          res.writeHead(200, { ...out.headers, ...cors }); res.flushHeaders();
          const closers: (() => void)[] = [];
          out.stream((chunk) => (res.writableEnded ? false : res.write(chunk)), (fn) => closers.push(fn));
          res.on('close', () => closers.forEach((fn) => fn()));
          return;
        }
        if (out.raw !== undefined) { res.writeHead(out.status, { ...out.headers, ...cors }); res.end(out.raw); return; }
        res.writeHead(out.status, { 'Content-Type': 'application/json; charset=utf-8', ...out.headers, ...cors }); res.end(JSON.stringify(out.body));
        return;
      }

      // Static web portal (single-page app). Paths are confined to the web root.
      if (method !== 'GET' && method !== 'HEAD') { res.writeHead(405); res.end(); return; }
      let file = normalize(join(webRoot, path === '/' ? 'index.html' : path));
      if (!file.startsWith(webRoot) || !existsSync(file) || !statSync(file).isFile()) file = join(webRoot, 'index.html');
      if (!existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Web portal is not built. Run: npm run build:web'); return; }
      const html = file.endsWith('index.html');
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', ...securityHeaders(cfg), 'Content-Security-Policy': WEB_CSP, 'Cache-Control': html ? 'no-store' : 'public, max-age=3600' });
      res.end(method === 'HEAD' ? undefined : readFileSync(file));
    } catch (e) {
      app.log.error('server adapter error', { error: (e as Error).message });
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } }));
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000; server.keepAliveTimeout = 65000;
  return new Promise((ok) => server.listen(cfg.port, cfg.host, () => ok(server)));
}

/** Timers for the in-process worker: outbox relay + job queue every 250 ms, schedulers every 5 s. */
export function startBackground(app: App): () => void {
  const a = setInterval(() => app.kick(), 250); const b = setInterval(() => { void app.runSchedulers().catch((e) => app.log.error('schedulers failed', { error: (e as Error).message })); }, 5000);
  const c = setInterval(() => { void app.jobs.recoverStuck(); }, 60000);
  return () => { clearInterval(a); clearInterval(b); clearInterval(c); };
}
