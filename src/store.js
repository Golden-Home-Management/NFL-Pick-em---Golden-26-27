'use strict';
/**
 * Persistence. The whole pool is one JSON document - with five players and a
 * 20-week season it is a few dozen kilobytes, so a document store is both the
 * simplest and the most reliable option here.
 *
 * Two interchangeable backends:
 *   file      - atomic write to a JSON file (local dev, Render/Fly/Railway disk)
 *   postgres  - a single jsonb row (Supabase / Neon / any Postgres; works on
 *               serverless hosts such as Vercel where the filesystem is read-only)
 *
 * Writes are serialised through a promise chain so two people submitting picks
 * at the same time cannot clobber each other's changes.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

class FileBackend {
  constructor(file) {
    this.file = path.resolve(file);
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async save(doc) {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    // Write-then-rename: a crash mid-write can never leave a truncated file.
    const handle = await fsp.open(tmp, 'w');
    try {
      await handle.writeFile(JSON.stringify(doc, null, 2), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(tmp, this.file);
  }
}

class PostgresBackend {
  /**
   * Tuned for serverless, where this is the hard-won shape:
   *
   * Supabase's pooler shuts the tenant pool down a couple of minutes after the
   * last client disconnects. The next visitor therefore pays a full pooler
   * cold start, which can take several seconds. A pg.Pool with no connection
   * timeout simply *waits* through that, so on Vercel's Hobby plan the 10s
   * function limit killed the request and the visitor saw nothing at all.
   *
   * So: fail fast rather than hang, then retry once - the retry lands on a
   * pool that the first attempt just warmed up, which is exactly the case
   * that was failing.
   */
  constructor(connectionString) {
    // Required lazily so `pg` is only needed when this backend is selected.
    const { Pool } = require('pg');
    const local = /localhost|127\.0\.0\.1/.test(connectionString);
    this.pool = new Pool({
      connectionString,
      // One request per instance at a time, so one connection is enough and
      // we hold the fewest possible slots on the shared pooler.
      max: 1,
      // Never wait indefinitely for a connection - surface a real error.
      connectionTimeoutMillis: local ? 5000 : 4000,
      // Release promptly; a frozen serverless instance should not sit on a slot.
      idleTimeoutMillis: 5000,
      // A query that somehow runs long must not eat the whole function budget.
      statement_timeout: 8000,
      ssl: local ? false : { rejectUnauthorized: false },
    });
    // Swallow background errors on idle clients; a dropped pooler connection
    // is routine here and must not take the process down.
    this.pool.on('error', () => {});
    this.tableChecked = false;
  }

  /** Is this worth a second attempt? Connection-level failures are; SQL errors are not. */
  static isTransient(err) {
    const code = err && err.code;
    return (
      code === 'ETIMEDOUT' ||
      code === 'ECONNRESET' ||
      code === 'ECONNREFUSED' ||
      code === 'EPIPE' ||
      code === '57P01' || // admin_shutdown
      code === '57P03' || // cannot_connect_now - pooler still starting
      code === '08006' ||
      code === '08003' ||
      /timeout exceeded when trying to connect|Connection terminated/i.test(String(err && err.message))
    );
  }

  async query(text, values) {
    try {
      return await this.pool.query(text, values);
    } catch (err) {
      // The table is created lazily: paying for a CREATE TABLE round trip on
      // every cold start was a measurable slice of the budget that was being
      // overrun, and it only ever matters once.
      if (err && err.code === '42P01' && !this.tableChecked) {
        this.tableChecked = true;
        await this.pool.query(
          'CREATE TABLE IF NOT EXISTS pool_state (id int PRIMARY KEY, doc jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())'
        );
        return this.pool.query(text, values);
      }
      if (PostgresBackend.isTransient(err)) {
        // The failed attempt has woken the pooler; the retry usually lands.
        return this.pool.query(text, values);
      }
      throw err;
    }
  }

  async load() {
    const res = await this.query('SELECT doc FROM pool_state WHERE id = 1');
    return res.rows.length ? res.rows[0].doc : null;
  }

  async save(doc) {
    await this.query(
      `INSERT INTO pool_state (id, doc, updated_at) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`,
      [JSON.stringify(doc)]
    );
  }
}

class MemoryBackend {
  constructor(seed) {
    this.doc = seed ? JSON.parse(JSON.stringify(seed)) : null;
  }
  async load() {
    return this.doc ? JSON.parse(JSON.stringify(this.doc)) : null;
  }
  async save(doc) {
    this.doc = JSON.parse(JSON.stringify(doc));
  }
}

class Store {
  constructor(backend, defaults) {
    this.backend = backend;
    this.defaults = defaults;
    this.chain = Promise.resolve();
  }

  /**
   * Read the current document. Deliberately uncached: the document is tens of
   * kilobytes, so re-reading it per request costs nothing and removes any way
   * for this process to serve stale data - which matters on serverless hosts
   * that run many instances, and if anyone edits the file or reseeds behind
   * the server's back.
   */
  async read() {
    let doc = await this.backend.load();
    if (!doc) {
      doc = this.defaults();
      await this.backend.save(doc);
    }
    return doc;
  }

  /**
   * Run `fn(doc)` against a fresh copy of the document and persist the result.
   * Mutations are queued, so two people submitting picks in the same second are
   * applied one at a time instead of clobbering each other.
   * Whatever `fn` returns is handed back to the caller.
   */
  async mutate(fn) {
    const run = this.chain.then(async () => {
      let doc = await this.backend.load();
      if (!doc) doc = this.defaults();
      const result = await fn(doc);
      await this.backend.save(doc);
      return result;
    });
    // Keep the chain alive even if this mutation rejected.
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }
}

function createStore(config, defaults) {
  let backend;
  if (config.storage === 'postgres') {
    if (!config.databaseUrl) throw new Error('STORAGE=postgres requires DATABASE_URL');
    backend = new PostgresBackend(config.databaseUrl);
  } else if (config.storage === 'memory') {
    backend = new MemoryBackend(config.seed);
  } else {
    backend = new FileBackend(config.dataFile);
  }
  return new Store(backend, defaults);
}

module.exports = { createStore, Store, FileBackend, PostgresBackend, MemoryBackend };
