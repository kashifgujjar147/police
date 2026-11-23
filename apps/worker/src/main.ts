// Separate worker process: outbox relay, job queue and schedulers. Use with STORE=mongo and WORKER_IN_PROCESS=false on the API.
// (The file store is single-process; with it, the API runs the worker in-process.)
import { ConfigError, loadConfig } from '@sf/config';
import { createApp } from '../../api/src/app.ts';
import { startBackground } from '../../api/src/server.ts';

async function main() {
  let config;
  try { config = loadConfig(); } catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exit(78); } throw e; }
  if (config.store !== 'mongo') { console.error('The separate worker needs STORE=mongo. With the file store, the API process runs the worker itself.'); process.exit(78); }
  const app = await createApp({ config: { ...config, runWorkerInProcess: true } });
  const stop = startBackground(app);
  app.log.info('SmartForce 360 worker started', { store: app.store.kind });
  const shutdown = async () => { stop(); await app.idle(); await app.store.close(); process.exit(0); };
  process.on('SIGTERM', () => void shutdown()); process.on('SIGINT', () => void shutdown());
}
main().catch((e) => { console.error('fatal:', e?.message ?? e); process.exit(1); });
