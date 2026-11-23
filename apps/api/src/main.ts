// API entry point. With WORKER_IN_PROCESS (default) this single process also runs the relay, job worker and schedulers.
import { ConfigError, loadConfig } from '@sf/config';
import { createApp } from './app.ts';
import { startBackground, startServer } from './server.ts';

async function main() {
  let config;
  try { config = loadConfig(); } catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exit(78); } throw e; }
  const app = await createApp({ config });
  if (config.mfaDevBypass) app.log.warn('DEVELOPMENT MFA BYPASS is on (AUTH_MFA_REQUIRED=false): admin sign-in is password-only. Never use outside local development.', {});
  if (config.demoMode) app.log.warn('DEMO MODE is on: this deployment may contain labelled demonstration data. Never enable in production.', {});
  const server = await startServer(app);
  const stopBg = config.runWorkerInProcess ? startBackground(app) : () => {};
  app.log.info('SmartForce 360 API listening', { port: config.port, store: app.store.kind, worker: config.runWorkerInProcess ? 'in-process' : 'separate', routes: app.routes.length, env: config.env });
  const shutdown = async (signal: string) => { // graceful: stop intake, finish in-flight work, flush the store
    app.log.info('shutting down', { signal }); stopBg(); server.close();
    const t = setTimeout(() => process.exit(1), 30000); t.unref();
    await app.idle(); await app.store.close(); process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM')); process.on('SIGINT', () => void shutdown('SIGINT'));
}
main().catch((e) => { console.error('fatal:', e?.message ?? e); process.exit(1); });
