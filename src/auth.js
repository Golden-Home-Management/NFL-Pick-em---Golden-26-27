'use strict';
/**
 * Lightweight auth. No accounts, no passwords to reset.
 *
 *  - Participants sign in by picking their name + a 4-digit PIN, or by opening
 *    their personal link (?p=<token>), which signs them in automatically.
 *  - The commissioner signs in with the ADMIN_PIN.
 *
 * A session is an HMAC-signed cookie: "<payload>.<expiry>.<signature>".
 * There is nothing to steal server-side and nothing to expire manually.
 */

const crypto = require('crypto');

const SESSION_DAYS = 120;

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function makeToken(payload, secret, days = SESSION_DAYS) {
  const expiry = Date.now() + days * 86400000;
  const body = `${payload}.${expiry}`;
  return `${body}.${sign(body, secret)}`;
}

function readToken(token, secret) {
  if (typeof token !== 'string') return null;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return null;
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = sign(body, secret);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const sep = body.lastIndexOf('.');
  const payload = body.slice(0, sep);
  const expiry = Number(body.slice(sep + 1));
  if (!Number.isFinite(expiry) || expiry < Date.now()) return null;
  return payload;
}

/** Constant-time compare for PINs so we do not leak digits by timing. */
function pinMatches(input, expected) {
  const a = Buffer.from(String(input ?? ''));
  const b = Buffer.from(String(expected ?? ''));
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieString(name, value, { maxAge = SESSION_DAYS * 86400, secure = false } = {}) {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

module.exports = { makeToken, readToken, pinMatches, parseCookies, cookieString, SESSION_DAYS };
