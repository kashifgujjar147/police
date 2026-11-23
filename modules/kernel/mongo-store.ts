// MongoDB adapter for the Store port (TS §2.1, §8). Requires the optional `mongodb` driver and a replica set (transactions).
// STATUS: Implemented (unverified) — this adapter could not be executed in the build environment (no MongoDB, no network).
// It implements exactly the filter/update subset in store.ts; run `npm run test:mongo` against a replica set before relying on it.
import { AsyncLocalStorage } from 'node:async_hooks';
import { COLLECTIONS, type Doc, DuplicateKeyError, type Filter, type FindOpts, type Store, type Update, newId } from './store.ts';

export class MongoStore implements Store {
  readonly kind = 'mongo';
  private als = new AsyncLocalStorage<{ session: any }>();
  private constructor(private client: any, private db: any) {}

  static async connect(url: string, dbName: string): Promise<MongoStore> {
    const name = 'mongodb';
    const { MongoClient } = (await import(name)) as any;
    const client = new MongoClient(url, { appName: 'smartforce360', retryWrites: true, w: 'majority', maxPoolSize: 50 });
    await client.connect();
    const store = new MongoStore(client, client.db(dbName));
    await store.ensureIndexes();
    return store;
  }
  /** Idempotent, forward-only index creation from the schema inventory; recorded in migration_log. */
  async ensureIndexes() {
    for (const [name, def] of Object.entries(COLLECTIONS)) {
      const col = this.db.collection(name);
      for (const fields of def.unique ?? []) {
        const sparseFields = fields.filter((f) => f !== 'tenantId');
        // Unique keys are "sparse" in the application sense: enforce only when every non-tenant field is present.
        await col.createIndex(Object.fromEntries(fields.map((f) => [f, 1])), { unique: true, partialFilterExpression: Object.fromEntries(sparseFields.map((f) => [f, { $exists: true }])), name: `u_${fields.join('_')}` });
      }
      for (const fields of def.indexes ?? []) await col.createIndex(Object.fromEntries(fields.map((f) => [f, 1])), { name: `i_${fields.join('_')}` });
    }
    await this.db.collection('migration_log').updateOne({ id: '0001-schema-inventory-indexes' }, { $setOnInsert: { id: '0001-schema-inventory-indexes', appliedAt: Date.now() } }, { upsert: true });
  }
  private opts() { const s = this.als.getStore(); return s ? { session: s.session } : {}; }
  private wrap<T>(c: string, fn: () => Promise<T>): Promise<T> {
    return fn().catch((e: any) => { if (e?.code === 11000) throw new DuplicateKeyError(c, Object.keys(e.keyPattern ?? {})); throw e; });
  }
  private toUpdate(u: Update) {
    const out: Record<string, unknown> = {};
    if (u.$set && Object.keys(u.$set).length) out.$set = u.$set;
    if (u.$inc) out.$inc = u.$inc;
    if (u.$push) out.$push = u.$push;
    if (u.$unset?.length) out.$unset = Object.fromEntries(u.$unset.map((k) => [k, '']));
    return out;
  }
  private guard(c: string, system?: boolean) { if (COLLECTIONS[c]!.immutable && !system) throw new Error(`collection ${c} is append-only: updates are not permitted`); }

  insert(c: string, doc: Record<string, unknown>): Promise<Doc> {
    const d = { ...doc, _id: (doc._id as string) ?? newId() } as Doc;
    return this.wrap(c, async () => { await this.db.collection(c).insertOne(d, this.opts()); return d; });
  }
  findOne(c: string, filter: Filter, opts: FindOpts = {}): Promise<Doc | null> { return this.db.collection(c).findOne(filter, { ...this.opts(), sort: opts.sort }); }
  find(c: string, filter: Filter, opts: FindOpts = {}): Promise<Doc[]> {
    let cur = this.db.collection(c).find(filter, this.opts());
    if (opts.sort) cur = cur.sort(opts.sort); if (opts.skip) cur = cur.skip(opts.skip); if (opts.limit !== undefined) cur = cur.limit(opts.limit);
    return cur.toArray();
  }
  count(c: string, filter: Filter): Promise<number> { return this.db.collection(c).countDocuments(filter, this.opts()); }
  updateOne(c: string, filter: Filter, update: Update, o: { system?: boolean } = {}): Promise<Doc | null> {
    this.guard(c, o.system);
    return this.wrap(c, () => this.db.collection(c).findOneAndUpdate(filter, this.toUpdate(update), { ...this.opts(), returnDocument: 'after' }));
  }
  async updateMany(c: string, filter: Filter, update: Update, o: { system?: boolean } = {}): Promise<number> {
    this.guard(c, o.system);
    return this.wrap(c, async () => (await this.db.collection(c).updateMany(filter, this.toUpdate(update), this.opts())).modifiedCount);
  }
  async deleteMany(c: string, filter: Filter, o: { retention?: boolean } = {}): Promise<number> {
    if (COLLECTIONS[c]!.immutable && !o.retention) throw new Error(`collection ${c} is append-only: deletes need the retention role`);
    return (await this.db.collection(c).deleteMany(filter, this.opts())).deletedCount;
  }
  async nextCounter(tenantId: string | null, name: string, period: string): Promise<number> {
    const r = await this.db.collection('counters').findOneAndUpdate({ tenantId, name, period }, { $inc: { value: 1 }, $setOnInsert: { _id: newId() } }, { ...this.opts(), upsert: true, returnDocument: 'after' });
    return r.value;
  }
  /** Multi-document transaction with majority write concern and snapshot read concern; the driver retries transient errors. */
  async transaction<R>(fn: () => Promise<R>): Promise<R> {
    if (this.als.getStore()) return fn();
    const session = this.client.startSession();
    try { return await session.withTransaction(() => this.als.run({ session }, fn), { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }); } finally { await session.endSession(); }
  }
  async ready() { try { await this.db.command({ ping: 1 }); return { ok: true, detail: 'mongo reachable' }; } catch (e) { return { ok: false, detail: (e as Error).message }; } }
  async close() { await this.client.close(); }
}
