'use strict';
const fs = require('fs');
const path = require('path');

/** Minimal .env loader so `npm start` works with no extra dependency. */
function loadEnvFile(file = path.join(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i < 0) continue;
    const key = trimmed.slice(0, i).trim();
    let value = trimmed.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function buildConfig(env = process.env) {
  const secret = env.SESSION_SECRET || 'golden-pool-dev-secret-change-me';
  if (!env.SESSION_SECRET && env.NODE_ENV === 'production') {
    console.warn('[golden-pool] SESSION_SECRET is not set - sessions will not survive a restart safely.');
  }
  return {
    port: Number(env.PORT) || 3000,
    season: Number(env.SEASON) || new Date().getUTCFullYear(),
    oddsApiKey: env.ODDS_API_KEY || '',
    adminPin: env.ADMIN_PIN || '1234',
    sessionSecret: secret,
    storage: env.STORAGE || (env.DATABASE_URL ? 'postgres' : 'file'),
    dataFile: env.DATA_FILE || './data/pool.json',
    databaseUrl: env.DATABASE_URL || '',
    cronSecret: env.CRON_SECRET || '',
  };
}

module.exports = { loadEnvFile, buildConfig };
