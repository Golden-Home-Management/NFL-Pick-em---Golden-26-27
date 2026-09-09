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
  constructor(connectionString) {
    // Required lazily so `pg` is only needed when this backend is selected.
    const { Pool } = require('pg');
    this.pool = new Pool({
      connectionString,
      max: 3,
      ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false },
    });
    this.ready = null;
  }

  async init() {
    if (!this.ready) {
      this.ready = this.pool.query(
        'CREATE TABLE IF NOT EXISTS pool_state (id int PRIMARY KEY, doc jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())'
      );
    }
    return this.ready;
  }

  async load() {
    await this.init();
    const res = await this.pool.query('SELECT doc FROM pool_state WHERE id = 1');
    return res.rows.length ? res.rows[0].doc : null;
  }

  async save(doc) {
    await this.init();
    await this.pool.query(
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
