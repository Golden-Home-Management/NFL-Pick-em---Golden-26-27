'use strict';
/**
 * Login throttling.
 *
 * State lives in the stored document, not in process memory, because on a
 * serverless host every request may run in a fresh instance - in-memory
 * counters there would reset constantly and protect nothing.
 *
 * Failures are counted per key (an IP for the commissioner, a participant id
 * for players). After MAX_FAILURES inside WINDOW_MS the key is locked for
 * LOCKOUT_MS. A success clears the record.
 */

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
const MAX_TRACKED = 200;

function bucket(doc) {
  if (!doc.loginAttempts || typeof doc.loginAttempts !== 'object') doc.loginAttempts = {};
  return doc.loginAttempts;
}

/**
 * Is this key currently locked out? Returns remaining seconds, or 0.
 * Read-only, so it is safe to call on a document we are not saving.
 */
function lockedFor(doc, key, now = Date.now()) {
  const rec = (doc.loginAttempts || {})[key];
  if (!rec || !rec.lockedUntil) return 0;
  const left = rec.lockedUntil - now;
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/** Record a failed attempt. Returns { failures, lockedSeconds }. */
function recordFailure(doc, key, now = Date.now()) {
  const store = bucket(doc);
  let rec = store[key];

  // Start a fresh window if the old one has expired and no lock is active.
  if (!rec || (now - rec.firstAt > WINDOW_MS && (!rec.lockedUntil || rec.lockedUntil <= now))) {
    rec = { failures: 0, firstAt: now, lockedUntil: null };
  }
  rec.failures += 1;
  rec.lastAt = now;
  if (rec.failures >= MAX_FAILURES) {
    rec.lockedUntil = now + LOCKOUT_MS;
  }
  store[key] = rec;
  prune(store, now);
  return {
    failures: rec.failures,
    lockedSeconds: rec.lockedUntil && rec.lockedUntil > now ? Math.ceil((rec.lockedUntil - now) / 1000) : 0,
  };
}

/** Clear a key after a successful sign-in. */
function clearFailures(doc, key) {
  const store = bucket(doc);
  delete store[key];
}

/** Drop expired records, and cap the table so it cannot grow without bound. */
function prune(store, now = Date.now()) {
  for (const [k, rec] of Object.entries(store)) {
    const lockActive = rec.lockedUntil && rec.lockedUntil > now;
    if (!lockActive && now - (rec.lastAt || rec.firstAt || 0) > WINDOW_MS) delete store[k];
  }
  const keys = Object.keys(store);
  if (keys.length > MAX_TRACKED) {
    keys
      .sort((a, b) => (store[a].lastAt || 0) - (store[b].lastAt || 0))
      .slice(0, keys.length - MAX_TRACKED)
      .forEach((k) => delete store[k]);
  }
}

/** Best-effort client IP behind Vercel / Render / any reverse proxy. */
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/** How strong is the configured admin PIN? Used for a startup warning. */
function assessPin(pin) {
  const s = String(pin || '');
  const weak = ['1234', '0000', '1111', '123456', 'admin', 'password'];
  return {
    length: s.length,
    isDefaultOrCommon: weak.includes(s),
    digitsOnly: /^\d+$/.test(s),
    // 4 digits is 10k combinations - fine with lockout, thin without it.
    tooShort: s.length < 6,
  };
}

module.exports = {
  MAX_FAILURES,
  WINDOW_MS,
  LOCKOUT_MS,
  lockedFor,
  recordFailure,
  clearFailures,
  clientIp,
  assessPin,
};
