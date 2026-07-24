/**
 * lib/telegram-auth.mjs — Login-with-Telegram verification + signed sessions.
 *
 * Telegram's login widget hands the browser a set of user fields plus a `hash`.
 * The hash is an HMAC-SHA256 over the other fields, keyed by SHA256(bot_token) —
 * so anyone holding the bot token (only the server) can prove the fields came
 * from Telegram and were not edited in the browser.
 *
 * Everything here is pure and dependency-free (node:crypto only), so the
 * gateway, the tests, and any future front-end share one implementation.
 *
 * Spec: https://core.telegram.org/widgets/login#checking-authorization
 */

import { createHmac, createHash, timingSafeEqual, randomBytes } from 'node:crypto';

/** Widget payloads older than this are refused (replay window). */
export const MAX_AUTH_AGE_SECONDS = 86_400;

/** Constant-time compare of two hex strings of equal length. */
function safeEqualHex(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verify a Telegram login-widget payload.
 *
 * @param {Record<string, string>} params - Widget fields, including `hash`.
 * @param {string} botToken
 * @param {{now?: number, maxAgeSeconds?: number}} [opts]
 * @returns {{ok: true, userId: string, user: object} | {ok: false, reason: string}}
 */
export function verifyTelegramLogin(params, botToken, opts = {}) {
  const { now = Math.floor(Date.now() / 1000), maxAgeSeconds = MAX_AUTH_AGE_SECONDS } = opts;
  if (!botToken) return { ok: false, reason: 'server has no bot token' };
  const { hash, ...fields } = params || {};
  if (!hash) return { ok: false, reason: 'missing hash' };
  if (!fields.id) return { ok: false, reason: 'missing id' };

  // The data-check string is every field except `hash`, as `key=value`, sorted
  // by key, joined with newlines. Any edited field changes the digest.
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');

  const secret = createHash('sha256').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (!safeEqualHex(expected, hash)) return { ok: false, reason: 'bad hash — payload was tampered with or the bot token is wrong' };

  const authDate = Number(fields.auth_date || 0);
  if (!authDate) return { ok: false, reason: 'missing auth_date' };
  if (now - authDate > maxAgeSeconds) return { ok: false, reason: 'login is too old — sign in again' };
  // A timestamp from the future means a forged or badly-skewed payload.
  if (authDate - now > 300) return { ok: false, reason: 'auth_date is in the future' };

  return {
    ok: true,
    userId: String(fields.id),
    user: {
      id: String(fields.id),
      firstName: fields.first_name || '',
      lastName: fields.last_name || '',
      username: fields.username || '',
      photoUrl: fields.photo_url || '',
    },
  };
}

/**
 * Mint a signed session token: `<userId>.<expiresAt>.<hmac>`.
 *
 * Signed rather than random-and-stored so the gateway stays stateless and a
 * restart does not log everyone out. The signature covers the expiry, so a
 * client cannot extend its own session.
 *
 * @param {string} userId
 * @param {string} secret
 * @param {{ttlSeconds?: number, now?: number}} [opts]
 * @returns {string}
 */
export function signSession(userId, secret, { ttlSeconds = 30 * 86_400, now = Math.floor(Date.now() / 1000) } = {}) {
  const expiresAt = now + ttlSeconds;
  const body = `${userId}.${expiresAt}`;
  const sig = createHmac('sha256', secret).update(body).digest('hex');
  return `${body}.${sig}`;
}

/**
 * Validate a session token.
 *
 * @param {string} token
 * @param {string} secret
 * @param {{now?: number}} [opts]
 * @returns {{ok: true, userId: string} | {ok: false, reason: string}}
 */
export function verifySession(token, secret, { now = Math.floor(Date.now() / 1000) } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed session' };
  const [userId, expiresAt, sig] = parts;
  const expected = createHmac('sha256', secret).update(`${userId}.${expiresAt}`).digest('hex');
  if (!safeEqualHex(expected, sig)) return { ok: false, reason: 'bad signature' };
  if (!/^\d+$/.test(expiresAt) || Number(expiresAt) < now) return { ok: false, reason: 'session expired' };
  return { ok: true, userId };
}

/**
 * Session-signing secret. Derived from the bot token when none is configured so
 * a fresh deployment works without extra setup — but it is NOT the bot token
 * itself, so leaking a session cookie can never expose the token.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string}
 */
export function sessionSecret(env = process.env) {
  if (env.CAREER_OPS_SESSION_SECRET) return env.CAREER_OPS_SESSION_SECRET;
  if (env.TELEGRAM_BOT_TOKEN) {
    return createHash('sha256').update(`career-ops-session|${env.TELEGRAM_BOT_TOKEN}`).digest('hex');
  }
  // No token at all (tests, first boot): random per process — sessions simply
  // do not survive a restart, which is safe, just inconvenient.
  return randomBytes(32).toString('hex');
}

/** Parse a Cookie header into a plain object. */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
