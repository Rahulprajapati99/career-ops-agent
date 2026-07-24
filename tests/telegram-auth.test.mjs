// tests/telegram-auth.test.mjs — Phase 7 Login-with-Telegram + signed sessions.
//
// This is the whole security boundary of the web dashboard: it decides who gets
// a session, and the gateway routes each session to exactly one user's data
// root. Every rejection path is tested, because a hole here is a hole into
// another family member's resume, tracker, and contacts.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { createHmac, createHash } from 'crypto';

console.log('\nTelegram login + sessions — lib/telegram-auth.mjs (Phase 7)');

const BOT_TOKEN = '1234567890:AAFakeTokenForTestsOnly_NotReal';

/** Build a widget payload signed the way Telegram signs it. */
function signWidget(fields, token = BOT_TOKEN) {
  const dataCheckString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = createHash('sha256').update(token).digest();
  return { ...fields, hash: createHmac('sha256', secret).update(dataCheckString).digest('hex') };
}

try {
  const { verifyTelegramLogin, signSession, verifySession, sessionSecret, parseCookies } =
    await import(pathToFileURL(join(ROOT, 'lib', 'telegram-auth.mjs')).href);

  const now = 1_800_000_000;
  const base = { id: '8772217091', first_name: 'Rahul', username: 'rahul', auth_date: String(now - 60) };

  // --- the happy path -------------------------------------------------------
  const good = verifyTelegramLogin(signWidget(base), BOT_TOKEN, { now });
  if (good.ok && good.userId === '8772217091') pass('a genuine Telegram payload verifies');
  else fail(`genuine payload rejected: ${JSON.stringify(good)}`);

  if (good.user?.username === 'rahul') pass('user fields are returned for display');
  else fail('user fields missing');

  // --- forgery --------------------------------------------------------------
  // The attack that matters: keep a valid hash, swap the id to another user's.
  const stolen = { ...signWidget(base), id: '9999999999' };
  const swapped = verifyTelegramLogin(stolen, BOT_TOKEN, { now });
  if (!swapped.ok) pass('swapping the id after signing is rejected (no impersonation)');
  else fail('IMPERSONATION: a tampered id verified successfully');

  const renamed = { ...signWidget(base), first_name: 'Someone Else' };
  if (!verifyTelegramLogin(renamed, BOT_TOKEN, { now }).ok) pass('editing any signed field is rejected');
  else fail('tampered field accepted');

  const wrongToken = verifyTelegramLogin(signWidget(base, 'other-token'), BOT_TOKEN, { now });
  if (!wrongToken.ok) pass('a payload signed with a different bot token is rejected');
  else fail('foreign bot token accepted');

  if (!verifyTelegramLogin({ ...base }, BOT_TOKEN, { now }).ok) pass('a payload with no hash at all is rejected');
  else fail('unsigned payload accepted');

  const noId = signWidget({ first_name: 'X', auth_date: String(now) });
  if (!verifyTelegramLogin(noId, BOT_TOKEN, { now }).ok) pass('a payload without an id is rejected');
  else fail('id-less payload accepted');

  if (!verifyTelegramLogin(signWidget(base), '', { now }).ok) pass('no server token → refuse rather than trust');
  else fail('verified with an empty bot token');

  // --- replay / clock -------------------------------------------------------
  const old = verifyTelegramLogin(signWidget({ ...base, auth_date: String(now - 200_000) }), BOT_TOKEN, { now });
  if (!old.ok && /too old/.test(old.reason)) pass('a stale login payload is refused (replay window)');
  else fail(`stale payload: ${JSON.stringify(old)}`);

  const future = verifyTelegramLogin(signWidget({ ...base, auth_date: String(now + 9999) }), BOT_TOKEN, { now });
  if (!future.ok) pass('a future-dated payload is refused');
  else fail('future auth_date accepted');

  // --- sessions -------------------------------------------------------------
  const secret = 'test-session-secret';
  const token = signSession('8772217091', secret, { now });
  const session = verifySession(token, secret, { now });
  if (session.ok && session.userId === '8772217091') pass('a signed session round-trips');
  else fail(`session round-trip failed: ${JSON.stringify(session)}`);

  if (!verifySession(token, 'different-secret', { now }).ok) pass('a session signed with another secret is rejected');
  else fail('cross-secret session accepted');

  const expired = signSession('8772217091', secret, { now: now - 40 * 86400, ttlSeconds: 86400 });
  if (!verifySession(expired, secret, { now }).ok) pass('an expired session is rejected');
  else fail('expired session accepted');

  // Self-extension: rewrite the expiry but keep the old signature.
  const [uid, , sig] = token.split('.');
  const extended = `${uid}.${now + 999_999}.${sig}`;
  if (!verifySession(extended, secret, { now }).ok) pass('a client cannot extend its own session expiry');
  else fail('PRIVILEGE ESCALATION: rewritten expiry accepted');

  // Identity swap: keep a valid signature, change the user id.
  const hijack = `9999999999.${token.split('.')[1]}.${sig}`;
  if (!verifySession(hijack, secret, { now }).ok) pass('a client cannot swap the user id in its session');
  else fail('IMPERSONATION: rewritten session user id accepted');

  for (const bad of ['', 'garbage', 'a.b', 'a.b.c.d']) {
    if (verifySession(bad, secret, { now }).ok) { fail(`malformed session accepted: "${bad}"`); break; }
  }
  pass('malformed session tokens are rejected');

  // --- secret derivation ----------------------------------------------------
  const derived = sessionSecret({ TELEGRAM_BOT_TOKEN: BOT_TOKEN });
  if (derived && derived !== BOT_TOKEN) pass('the session secret is derived from, but never equal to, the bot token');
  else fail('session secret leaks the bot token');

  if (sessionSecret({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }) === derived) pass('secret derivation is stable across restarts');
  else fail('derived secret is not deterministic');

  if (sessionSecret({ CAREER_OPS_SESSION_SECRET: 'explicit' }) === 'explicit') pass('an explicit session secret wins');
  else fail('CAREER_OPS_SESSION_SECRET ignored');

  // --- cookies --------------------------------------------------------------
  const cookies = parseCookies('a=1; career_ops_session=x.y.z; b=two%20words');
  if (cookies.career_ops_session === 'x.y.z' && cookies.b === 'two words') pass('cookie parsing handles multiple + encoded values');
  else fail(`cookie parse: ${JSON.stringify(cookies)}`);

  if (Object.keys(parseCookies('')).length === 0 && Object.keys(parseCookies(undefined)).length === 0)
    pass('an absent Cookie header yields no cookies');
  else fail('empty cookie header mishandled');

  // --- gateway request gate -------------------------------------------------
  process.env.CAREER_OPS_GATEWAY_TEST = '1'; // keep the module from listening
  const { userFromRequest } = await import(pathToFileURL(join(ROOT, 'web-gateway.mjs')).href);
  const allowed = new Set(['8772217091']);
  const cookieHeader = `career_ops_session=${encodeURIComponent(token)}`;

  if (userFromRequest({ headers: { cookie: cookieHeader } }, secret, allowed) === '8772217091')
    pass('gateway resolves an allowlisted session to its user');
  else fail('gateway rejected a valid allowlisted session');

  if (userFromRequest({ headers: { cookie: cookieHeader } }, secret, new Set(['someone-else'])) === null)
    pass('allowlist is re-checked per request — removal locks a live session out immediately');
  else fail('SECURITY: a de-allowlisted user kept access via an unexpired cookie');

  if (userFromRequest({ headers: {} }, secret, allowed) === null) pass('no cookie → no user');
  else fail('anonymous request resolved to a user');

  if (userFromRequest({ headers: { cookie: 'career_ops_session=forged.123.abc' } }, secret, allowed) === null)
    pass('a forged cookie resolves to no user');
  else fail('forged cookie accepted');
} catch (err) {
  fail(`telegram-auth test crashed: ${err.message}`);
}
