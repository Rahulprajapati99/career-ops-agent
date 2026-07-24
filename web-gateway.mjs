#!/usr/bin/env node

/**
 * web-gateway.mjs — Phase 7: the multi-user front door for the web dashboard.
 *
 * The upstream dashboard in web/ is single-user by construction: it resolves
 * every path through one `careerOpsRoot()`, called from 47 places across 31
 * files. Threading a per-request user through all of them would mean forking
 * most of upstream's app and re-doing it after every `update-system.mjs`.
 *
 * So this reuses the Phase 1 keystone — isolation is a LAUNCHER, not a
 * refactor. One `next start` per signed-in user, each pinned to that user's own
 * data root via CAREER_OPS_ROOT, and this gateway in front doing auth and
 * routing. Upstream's app stays untouched and stays updatable, and isolation is
 * enforced by the OS (separate processes, separate roots) rather than by every
 * call site remembering to filter — a leak would take a kernel bug, not a
 * forgotten WHERE clause.
 *
 * Flow:
 *   GET  /            → dashboard (or the login page when signed out)
 *   GET  /login       → Telegram login widget
 *   GET  /auth/callback → verify widget hash → allowlist → signed cookie
 *   POST /logout      → clear cookie
 *   *                 → proxied to that user's own Next instance
 *
 * Usage:
 *   node web-gateway.mjs                 # port 8080
 *   node web-gateway.mjs --port 3000
 *   node web-gateway.mjs --check         # config check, no listen
 *
 * Env: TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_IDS, TELEGRAM_BOT_USERNAME,
 *      CAREER_OPS_PUBLIC_URL (https origin behind Cloudflare Tunnel),
 *      CAREER_OPS_SESSION_SECRET (optional).
 */

import 'dotenv/config';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, USERS_DIR, isValidUserId } from './user-env.mjs';
import { scaffoldUser } from './scaffold-user.mjs';
import { verifyTelegramLogin, signSession, verifySession, sessionSecret, parseCookies } from './lib/telegram-auth.mjs';

const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
};

const PORT = Number(argVal('--port', process.env.CAREER_OPS_WEB_PORT || 8080));
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '');
const PUBLIC_URL = (process.env.CAREER_OPS_PUBLIC_URL || '').replace(/\/$/, '');
const ALLOWED = new Set((process.env.TELEGRAM_ALLOWED_IDS || '').split(',').map((s) => s.trim()).filter(Boolean));
const SECRET = sessionSecret();
const COOKIE = 'career_ops_session';
/** First port for per-user Next instances; each user gets the next free one. */
const BASE_CHILD_PORT = Number(process.env.CAREER_OPS_CHILD_PORT_BASE || 41000);

/** userId → { port, proc, ready } */
const instances = new Map();

// ---------------------------------------------------------------------------
// Per-user Next instances
// ---------------------------------------------------------------------------
/**
 * Start (or reuse) the dashboard process bound to one user's data root.
 *
 * @param {string} userId
 * @returns {Promise<{port: number}>}
 */
async function instanceFor(userId) {
  const existing = instances.get(userId);
  if (existing?.proc && !existing.proc.killed) return existing;

  const root = join(USERS_DIR, userId);
  if (!existsSync(root)) scaffoldUser(userId);

  const port = BASE_CHILD_PORT + instances.size;
  const proc = spawn('npm', ['run', 'start', '--', '--port', String(port)], {
    cwd: join(REPO_ROOT, 'web'),
    // CAREER_OPS_ROOT is the whole isolation mechanism: this process can only
    // ever see one user's files, no matter what its request handlers do.
    env: { ...process.env, CAREER_OPS_ROOT: root, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  proc.stdout.on('data', (d) => process.stdout.write(`[web:${userId}] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[web:${userId}] ${d}`));
  proc.on('exit', (code) => {
    console.log(`[web:${userId}] exited (${code})`);
    instances.delete(userId);
  });

  const entry = { port, proc };
  instances.set(userId, entry);
  await waitForPort(port, 60_000);
  return entry;
}

/** Poll until the child answers, so the first request does not 502. */
async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'HEAD', timeout: 2000 }, resolve);
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.end();
      });
      return true;
    } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error(`dashboard did not start on port ${port} within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function loginPage(message = '') {
  const origin = PUBLIC_URL || `http://localhost:${PORT}`;
  const widget = BOT_USERNAME
    ? `<script async src="https://telegram.org/js/telegram-widget.js?22"
         data-telegram-login="${esc(BOT_USERNAME)}"
         data-size="large"
         data-userpic="false"
         data-auth-url="${esc(`${origin}/auth/callback`)}"
         data-request-access="write"></script>`
    : `<p class="warn">Set <code>TELEGRAM_BOT_USERNAME</code> in .env to show the login button.</p>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Career Ops — sign in</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:16px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
         background:#0b0d10; color:#e8eaed; }
  .card { width:min(92vw,420px); padding:2.5rem; border-radius:16px; background:#14171c;
          border:1px solid #232830; text-align:center; }
  h1 { margin:0 0 .25rem; font-size:1.5rem; letter-spacing:-.02em; }
  p { margin:.25rem 0 1.5rem; color:#9aa3af; font-size:.95rem; }
  .msg { margin-bottom:1rem; padding:.75rem 1rem; border-radius:10px;
         background:#3a1d1d; border:1px solid #6b2b2b; color:#ffb4b4; font-size:.9rem; }
  .warn { color:#ffcf8b; font-size:.9rem; }
  code { background:#0b0d10; padding:.15rem .4rem; border-radius:5px; }
  .foot { margin-top:1.75rem; font-size:.8rem; color:#6b7280; }
</style></head><body>
<div class="card">
  <h1>Career Ops</h1>
  <p>Sign in with the Telegram account the bot already knows.</p>
  ${message ? `<div class="msg">${esc(message)}</div>` : ''}
  ${widget}
  <div class="foot">Only allowlisted accounts can sign in.<br>Your data stays on this machine.</div>
</div></body></html>`;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------
/**
 * Resolve the signed-in user for a request, or null.
 * Exported for tests.
 */
export function userFromRequest(req, secret = SECRET, allowed = ALLOWED) {
  const token = parseCookies(req.headers?.cookie)[COOKIE];
  if (!token) return null;
  const result = verifySession(token, secret);
  if (!result.ok) return null;
  // The allowlist is re-checked on EVERY request, not just at login: removing
  // someone from TELEGRAM_ALLOWED_IDS must lock them out immediately, without
  // waiting for a 30-day cookie to expire.
  if (allowed.size && !allowed.has(result.userId)) return null;
  return result.userId;
}

async function handleAuthCallback(req, res, url) {
  const params = Object.fromEntries(url.searchParams.entries());
  const verdict = verifyTelegramLogin(params, TOKEN);
  if (!verdict.ok) {
    console.warn(`[auth] rejected login: ${verdict.reason}`);
    return send(res, 401, loginPage(`Sign-in failed: ${verdict.reason}`));
  }
  if (!isValidUserId(verdict.userId)) return send(res, 400, loginPage('Unusable Telegram id.'));
  if (ALLOWED.size && !ALLOWED.has(verdict.userId)) {
    console.warn(`[auth] blocked non-allowlisted id ${verdict.userId}`);
    return send(res, 403, loginPage(`Your Telegram id (${verdict.userId}) is not on the allowlist. Ask the admin to add it.`));
  }

  const token = signSession(verdict.userId, SECRET);
  console.log(`[auth] signed in ${verdict.userId} (${verdict.user.username || verdict.user.firstName})`);
  const secure = PUBLIC_URL.startsWith('https://') ? ' Secure;' : '';
  send(res, 302, '', {
    location: '/',
    'set-cookie': `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax;${secure} Max-Age=${30 * 86_400}`,
  });
}

/** Pipe a request through to the signed-in user's own dashboard instance. */
function proxy(req, res, port) {
  const upstream = http.request(
    { host: '127.0.0.1', port, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${port}` } },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`Dashboard unavailable: ${e.message}`);
  });
  req.pipe(upstream);
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { return send(res, 400, 'Bad request'); }

  if (url.pathname === '/auth/callback') return handleAuthCallback(req, res, url);

  if (url.pathname === '/logout') {
    return send(res, 302, '', { location: '/login', 'set-cookie': `${COOKIE}=; HttpOnly; Path=/; Max-Age=0` });
  }

  const userId = userFromRequest(req);

  if (url.pathname === '/login') {
    if (userId) return send(res, 302, '', { location: '/' });
    return send(res, 200, loginPage());
  }
  if (!userId) return send(res, 302, '', { location: '/login' });

  try {
    const { port } = await instanceFor(userId);
    proxy(req, res, port);
  } catch (e) {
    console.error(`[web:${userId}] start failed:`, e.message);
    send(res, 503, `<p>Your dashboard is still starting. Refresh in a few seconds.</p><pre>${esc(e.message)}</pre>`);
  }
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = process.argv[1]?.endsWith('web-gateway.mjs') && !process.env.CAREER_OPS_GATEWAY_TEST;
if (isMain) {
  const problems = [];
  if (!TOKEN) problems.push('TELEGRAM_BOT_TOKEN missing — logins cannot be verified.');
  if (!BOT_USERNAME) problems.push('TELEGRAM_BOT_USERNAME missing — the login button cannot render.');
  if (ALLOWED.size === 0) problems.push('TELEGRAM_ALLOWED_IDS empty — nobody can sign in.');
  if (!existsSync(join(REPO_ROOT, 'web', 'node_modules'))) problems.push('web/node_modules missing — run: cd web && npm install && npm run build');
  if (!PUBLIC_URL) problems.push('CAREER_OPS_PUBLIC_URL not set — fine for localhost, required behind Cloudflare Tunnel.');

  if (args.includes('--check')) {
    console.log(problems.length ? `⚠️  ${problems.length} issue(s):` : '✅ Gateway configuration looks complete.');
    for (const p of problems) console.log(`   · ${p}`);
    process.exit(problems.length ? 1 : 0);
  }

  for (const p of problems) console.warn(`⚠️  ${p}`);
  server.listen(PORT, () => {
    console.log(`🌐 Career Ops gateway on http://localhost:${PORT}`);
    console.log(`   Sign-in: ${PUBLIC_URL || `http://localhost:${PORT}`}/login`);
    console.log(`   ${ALLOWED.size} allowlisted user(s); each gets an isolated dashboard process.`);
  });
}

export { server, loginPage, instances };
