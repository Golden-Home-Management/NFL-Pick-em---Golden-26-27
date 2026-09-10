'use strict';
/** Small test harness: boots the real app on a random port with a cookie jar. */

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createApp } = require('../src/app');

async function prepareSchema(connectionString, schema) {
  const { Client } = require('pg');
  const client = new Client({ connectionString });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.end();
}

function tempDataFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-pool-test-'));
  return path.join(dir, 'pool.json');
}

/**
 * Set TEST_DATABASE_URL to run the whole suite against the Postgres backend
 * instead of the JSON file - the same code path Supabase uses in production:
 *
 *   TEST_DATABASE_URL=postgres://user@host:5432/postgres npm test
 *
 * Each server gets its own schema so the suites cannot see each other's data.
 */
let schemaCounter = 0;

async function startServer(overrides = {}) {
  const testDb = process.env.TEST_DATABASE_URL;
  let storageDefaults = { storage: 'file', dataFile: tempDataFile(), databaseUrl: '' };
  if (testDb) {
    schemaCounter += 1;
    const schema = `ghm_test_${process.pid}_${schemaCounter}`;
    const url = new URL(testDb);
    url.searchParams.set('options', `-c search_path=${schema}`);
    await prepareSchema(testDb, schema);
    storageDefaults = { storage: 'postgres', dataFile: '', databaseUrl: url.toString() };
  }

  const config = {
    port: 0,
    season: 2026,
    oddsApiKey: 'test-key',
    adminPin: '9137',
    sessionSecret: 'test-secret-abcdefghijklmnop',
    ...storageDefaults,
    ...overrides,
  };
  const app = createApp(config);
  const server = http.createServer((req, res) => {
    app(req, res).catch((err) => {
      console.error(err);
      res.writeHead(500).end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, config, app, close: () => new Promise((r) => server.close(r)) };
}

/** A browser-ish client: keeps cookies, parses JSON, exposes the status code. */
function client(base, ip) {
  const jar = new Map();
  async function request(method, url, body) {
    const headers = {};
    // Behind a proxy this is what identifies the caller; login throttling keys
    // off it, so each test client needs its own.
    if (ip) headers['X-Forwarded-For'] = ip;
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const raw of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (value === '' ) jar.delete(name);
      else jar.set(name, value);
    }
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, ok: res.ok, data };
  }
  return {
    get: (url) => request('GET', url),
    post: (url, body = {}) => request('POST', url, body),
    jar,
  };
}

module.exports = { startServer, client };
