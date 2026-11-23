// Application composition: one modular monolith, three process roles (TS §4).
import type { AppConfig } from '@sf/config';
import { App, type Clock, FileStore, type Logger, MemoryStore, type Store, argon2Hasher, createLogger, scryptHasher, systemClock } from '@sf/kernel';
import { join } from 'node:path';
import { registerIdentity } from '../../../modules/identity/index.ts';
import { bootstrapPlatform, registerTenancy } from '../../../modules/tenancy/index.ts';
import { registerAccess } from '../../../modules/access/index.ts';
import { registerOrganisation } from '../../../modules/organisation/index.ts';
import { registerWorkforce } from '../../../modules/workforce/index.ts';
import { registerPrivacy } from '../../../modules/privacy/index.ts';
import { registerDuty } from '../../../modules/duty/index.ts';
import { registerAttendance } from '../../../modules/attendance/index.ts';
import { registerField } from '../../../modules/field/index.ts';
import { registerSafety } from '../../../modules/safety/index.ts';
import { registerNotifications } from '../../../modules/notifications/index.ts';
import { DiskFileStorage, type FileStorage, MemoryFileStorage, registerRecords } from '../../../modules/records/index.ts';

export interface CreateAppOptions { config: AppConfig; store?: Store; clock?: Clock; logger?: Logger; storage?: FileStorage; logSink?: (line: string) => void }

export async function createStore(config: AppConfig): Promise<Store> {
  if (config.store === 'memory') return new MemoryStore();
  if (config.store === 'file') return new FileStore(config.dataDir);
  const { MongoStore } = await import('../../../modules/kernel/mongo-store.ts');
  return MongoStore.connect(config.mongoUrl, config.mongoDb);
}

export async function createApp(opts: CreateAppOptions): Promise<App> {
  const { config } = opts; const clock = opts.clock ?? systemClock;
  const logger = opts.logger ?? createLogger(opts.logSink ?? ((l) => process.stdout.write(l + '\n')), clock, config.logLevel);
  const store = opts.store ?? (await createStore(config));
  let hasher = scryptHasher(config.hash);
  if (config.passwordAlgo === 'argon2id') { const a = await argon2Hasher(); if (!a) throw new Error('PASSWORD_ALGO=argon2id requires the optional "argon2" package to be installed'); hasher = a; }
  const app = new App({ store, clock, config, logger, hasher });
  const storage = opts.storage ?? (config.store === 'memory' ? new MemoryFileStorage() : new DiskFileStorage(join(config.dataDir, 'files')));
  registerNotifications(app); registerIdentity(app); registerTenancy(app); registerAccess(app); registerOrganisation(app); registerWorkforce(app);
  registerPrivacy(app); registerDuty(app); registerAttendance(app); registerField(app); registerSafety(app); registerRecords(app, storage);
  await bootstrapPlatform(app);
  await app.jobs.recoverStuck(0);
  return app;
}
