#!/usr/bin/env node

/**
 * smoke-test.mjs — production-parity health check for the Family Edition.
 *
 * Run this ON THE HOST THAT RUNS THE BOT (the VM). It exercises the same code
 * paths, config, and live APIs the bot uses, and prints a PASS/WARN/FAIL report
 * with the exact fix for anything broken — so a problem is diagnosed in one
 * command instead of a screenshot round-trip.
 *
 * Free by default: every credential is validated through an endpoint that costs
 * NO quota (Telegram getMe, Gemini models.list, SerpApi/Hunter account).
 *
 * Usage:
 *   node smoke-test.mjs                 # fast, free, no LLM calls
 *   node smoke-test.mjs --full          # ALSO runs a real evaluation (1 LLM call)
 *   node smoke-test.mjs --user <id>     # check one user (default: all)
 *
 * Exit code 0 = all good, 1 = at least one FAIL (CI/cron friendly).
 */

import 'dotenv/config';
import { execSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { REPO_ROOT, USERS_DIR, buildUserEnv } from './user-env.mjs';
import { cleanKey, isPlausibleApiKey } from './lib/api-key.mjs';

const args = process.argv.slice(2);
const FULL = args.includes('--full');
const ONLY_USER = args.includes('--user') ? args[args.indexOf('--user') + 1] : null;

let fails = 0;
let warns = 0;
const line = (icon, name, detail) => console.log(`${icon} ${name}${detail ? ` — ${detail}` : ''}`);
const pass = (n, d) => line('✅', n, d);
const warn = (n, d) => { warns++; line('⚠️ ', n, d); };
const fail = (n, d) => { fails++; line('❌', n, d); };
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}`);

async function getJson(url, opts = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 15_000);
  try {
    const res = await fetch(url, { signal: c.signal, ...opts });
    return { ok: res.ok, status: res.status, json: await res.json().catch(() => null) };
  } catch (e) {
    return { ok: false, status: 0, json: null, error: e.message };
  } finally { clearTimeout(t); }
}

// ---------------------------------------------------------------------------
console.log('🩺 Career-Ops Family Edition — production smoke test');

// --- 1. Version drift (the #1 cause of "works locally, fails on the VM") ----
section('Version');
let head = '';
try {
  head = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, encoding: 'utf-8' }).trim();
  const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: REPO_ROOT, encoding: 'utf-8' }).trim();
  pass('Git checkout', `${branch} @ ${head}`);
  try {
    execSync('git fetch origin --quiet', { cwd: REPO_ROOT, timeout: 20_000 });
    const behind = execSync(`git rev-list --count HEAD..origin/${branch}`, { cwd: REPO_ROOT, encoding: 'utf-8' }).trim();
    if (behind === '0') pass('Up to date with origin');
    else fail('BEHIND origin', `${behind} commit(s) behind — run: git pull origin ${branch} && pm2 restart career-ops-bot`);
  } catch { warn('Could not compare with origin', 'network/git remote unavailable'); }
} catch { warn('Not a git checkout', 'version drift cannot be detected'); }

// --- 2. Runtime -------------------------------------------------------------
section('Runtime');
const major = Number(process.versions.node.split('.')[0]);
if (major >= 18 && typeof fetch === 'function') pass('Node', `${process.version} (fetch available)`);
else fail('Node too old', `${process.version} — need >= 18 for global fetch`);

// --- 3. Required scripts present (catches a stale checkout missing a file) ---
section('Scripts');
const REQUIRED = ['telegram-bot.mjs', 'run-as-user.mjs', 'user-env.mjs', 'scaffold-user.mjs',
  'geo-policy.mjs', 'jd-fetch.mjs', 'ats-match.mjs', 'cv-import.mjs', 'set-key.mjs',
  'find-contact-email.mjs', 'gemini-email.mjs', 'gemini-cover.mjs', 'gemini-eval.mjs',
  'gemini-tailor.mjs', 'scan.mjs', 'providers/serpapi.mjs', 'providers/adzuna.mjs'];
const missing = REQUIRED.filter((f) => !existsSync(join(REPO_ROOT, f)));
if (missing.length === 0) pass('All required scripts present', `${REQUIRED.length} checked`);
else fail('Missing scripts', `${missing.join(', ')} — your checkout is stale; git pull`);

// --- 4. Credentials — validated LIVE, via zero-cost endpoints ---------------
section('Credentials (live, no quota consumed)');
const tok = process.env.TELEGRAM_BOT_TOKEN || '';
if (!tok) fail('TELEGRAM_BOT_TOKEN', 'missing from .env — the bot cannot run');
else {
  const r = await getJson(`https://api.telegram.org/bot${tok}/getMe`);
  if (r.json?.ok) pass('Telegram token', `@${r.json.result?.username}`);
  else fail('Telegram token rejected', `HTTP ${r.status} ${r.json?.description || r.error || ''} — revoke/reissue via @BotFather`);
}

const allow = (process.env.TELEGRAM_ALLOWED_IDS || '').split(',').filter(Boolean);
if (allow.length) pass('Allowlist', `${allow.length} user(s): ${allow.join(', ')}`);
else fail('TELEGRAM_ALLOWED_IDS missing', 'bot will refuse everyone');

const gem = process.env.GEMINI_API_KEY || '';
if (!gem) fail('GEMINI_API_KEY', 'missing — evaluation/tailor/cover will fail');
else {
  const r = await getJson(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(gem)}`);
  if (Array.isArray(r.json?.models) && r.json.models.length) pass('Gemini key', `${r.json.models.length} models visible`);
  else fail('Gemini key rejected', r.json?.error?.message || `HTTP ${r.status}`);
  // The key must also survive the BOT's own /setkey handling. This smoke test
  // used to validate the raw key straight from .env and report all-clear while
  // /setkey was corrupting the very same key before validating it.
  if (isPlausibleApiKey(cleanKey(gem))) pass('Gemini key survives /setkey handling', 'a user can set this key themselves');
  else fail('/setkey would reject this key format', 'the bot mangles or rejects keys it should accept');
}

if (process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY) {
  const r = await getJson(`https://api.adzuna.com/v1/api/jobs/ca/search/1?app_id=${process.env.ADZUNA_APP_ID}&app_key=${process.env.ADZUNA_APP_KEY}&results_per_page=1`);
  if (r.ok) pass('Adzuna credentials', 'search API reachable');
  else fail('Adzuna rejected', `HTTP ${r.status} — check ADZUNA_APP_ID/KEY`);
} else warn('Adzuna not configured', 'ADZUNA_APP_ID/KEY absent — US/CA aggregation disabled');

// --- 5. Per-user config + per-user API keys --------------------------------
section('Users');
const userDirs = existsSync(USERS_DIR)
  ? readdirSync(USERS_DIR).filter((d) => statSync(join(USERS_DIR, d)).isDirectory())
  : [];
const targets = ONLY_USER ? userDirs.filter((u) => u === ONLY_USER) : userDirs;
if (targets.length === 0) fail('No user folders', 'run: node scaffold-user.mjs <telegram_id>');

for (const u of targets) {
  const root = join(USERS_DIR, u);
  const env = buildUserEnv(root);
  const isGlobal = u === '_global';

  // profile
  let profile = null;
  try { profile = yaml.load(readFileSync(env.CAREER_OPS_PROFILE, 'utf-8')); } catch { /* below */ }
  if (profile) pass(`[${u}] profile.yml`, `${profile.candidate?.full_name || 'no name set'}`);
  else if (!isGlobal) fail(`[${u}] profile.yml unreadable`, env.CAREER_OPS_PROFILE);

  // cv
  const cvPath = join(root, 'cv.md');
  if (!isGlobal) {
    if (!existsSync(cvPath)) fail(`[${u}] cv.md missing`, 'user must upload a resume via the bot');
    else {
      const cv = readFileSync(cvPath, 'utf-8');
      if (cv.includes('Placeholder created by scaffold-user')) warn(`[${u}] cv.md is a placeholder`, 'user has not uploaded a resume yet');
      else pass(`[${u}] cv.md`, `${cv.length} chars`);
    }
  }

  // portals
  if (existsSync(env.CAREER_OPS_PORTALS)) {
    try {
      execFileSync(process.execPath, [join(REPO_ROOT, 'validate-portals.mjs'), '--file', env.CAREER_OPS_PORTALS], { stdio: 'pipe' });
      pass(`[${u}] portals.yml valid`);
    } catch (e) { fail(`[${u}] portals.yml invalid`, String(e.stdout || e.message).slice(0, 120)); }
  } else fail(`[${u}] portals.yml missing`, env.CAREER_OPS_PORTALS);

  // per-user integration keys (validated free)
  for (const [envName, label, url, ok] of [
    ['GEMINI_API_KEY', 'Gemini', (k) => `https://generativelanguage.googleapis.com/v1beta/models?key=${k}`, (j) => Array.isArray(j?.models) && j.models.length],
    ['SERPAPI_KEY', 'SerpApi', (k) => `https://serpapi.com/account.json?api_key=${k}`, (j) => j && !j.error],
    ['HUNTER_API_KEY', 'Hunter', (k) => `https://api.hunter.io/v2/account?api_key=${k}`, (j) => !!j?.data],
  ]) {
    const key = env[envName];
    if (!key) continue; // personal key not set — falls back to the shared one
    const r = await getJson(url(encodeURIComponent(key)));
    if (ok(r.json)) pass(`[${u}] personal ${label} key`, 'valid');
    else fail(`[${u}] personal ${label} key rejected`, 'fix with /setkey in the bot');
  }
}

// --- 6. Bot process ---------------------------------------------------------
section('Bot process');
try {
  const ps = process.platform === 'win32'
    ? execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object -ExpandProperty CommandLine"],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
    : execSync('ps -eo args', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  const running = ps.split('\n').filter((l) => /telegram-bot\.mjs/.test(l)).length;
  if (running === 1) pass('Bot running', '1 poller (correct)');
  else if (running === 0) fail('Bot NOT running', 'start it: pm2 start telegram-bot.mjs --name career-ops-bot');
  else fail('MULTIPLE bot processes', `${running} pollers — they will fight over Telegram updates; keep exactly one`);
} catch { warn('Could not inspect processes', 'check manually: pm2 list'); }

// --- 7. Optional live pipeline (costs 1 LLM call) --------------------------
if (FULL) {
  section('Live pipeline (--full)');
  const u = targets.find((t) => t !== '_global');
  const root = u ? join(USERS_DIR, u) : null;
  const jd = root ? join(root, 'data', 'temp_jd.txt') : null;
  if (!root || !jd || !existsSync(jd)) warn('Skipped evaluation', 'no saved JD to test with — send the bot a job URL first');
  else {
    try {
      const out = execFileSync(process.execPath, [join(REPO_ROOT, 'gemini-eval.mjs'), '--file', jd],
        { cwd: root, env: { ...process.env, ...buildUserEnv(root) }, encoding: 'utf-8', timeout: 300_000 });
      const score = out.match(/SCORE:\s*([\d.]+)/)?.[1];
      if (score) pass('Evaluation end-to-end', `scored ${score}/5`);
      else fail('Evaluation produced no score', out.split('\n').slice(-3).join(' · ').slice(0, 200));
    } catch (e) {
      const msg = String(e.stdout || e.stderr || e.message);
      if (/per\s*day|free_tier_requests|All models exhausted/i.test(msg)) warn('Evaluation quota-limited', 'daily free quota used up — resets midnight Pacific');
      else fail('Evaluation failed', msg.split('\n').filter(Boolean).slice(-2).join(' · ').slice(0, 200));
    }

    // Tailoring is a SEPARATE code path from evaluation, with its own model
    // fallback. Checking only evaluation is what let this smoke test report
    // all-clear while /tailor failed on every run.
    const reportsDir = join(root, 'reports');
    const newestReport = existsSync(reportsDir)
      ? readdirSync(reportsDir).filter((f) => f.endsWith('.md'))
        .map((f) => ({ f, t: statSync(join(reportsDir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)[0]?.f
      : null;
    if (!newestReport) warn('Skipped tailoring', 'no evaluation report to tailor from yet');
    else {
      try {
        const out = execFileSync(process.execPath,
          [join(REPO_ROOT, 'gemini-tailor.mjs'), '--jd', jd, '--report', join('reports', newestReport)],
          { cwd: root, env: { ...process.env, ...buildUserEnv(root) }, encoding: 'utf-8', timeout: 420_000 });
        const html = out.match(/HTML_PATH:\s*(.+)/)?.[1]?.trim();
        const fallback = out.match(/Generated by ([\w.-]+) \(fallback\)/)?.[1];
        if (html) pass('Tailoring end-to-end', fallback ? `produced a CV via fallback model ${fallback}` : 'produced a CV');
        else fail('Tailoring produced no CV', out.split('\n').filter(Boolean).slice(-3).join(' · ').slice(0, 200));
      } catch (e) {
        const msg = String(e.stdout || e.stderr || e.message);
        if (/All models busy|MODELS_BUSY/i.test(msg)) warn('Tailoring hit a demand spike', 'every model was busy — retry shortly');
        else if (/per\s*day|free_tier_requests|All models exhausted/i.test(msg)) warn('Tailoring quota-limited', 'every model\'s daily quota is used up');
        else fail('Tailoring failed', msg.split('\n').filter(Boolean).slice(-2).join(' · ').slice(0, 200));
      }
    }
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${fails === 0 ? '✅' : '❌'} smoke test: ${fails} failure(s), ${warns} warning(s)`);
if (fails === 0 && warns === 0) console.log('   Everything the bot depends on is healthy.');
process.exit(fails === 0 ? 0 : 1);
