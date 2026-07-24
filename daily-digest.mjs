#!/usr/bin/env node

/**
 * daily-digest.mjs — Phase 6: push each user their new, live, matching jobs.
 *
 * Runs from cron on the VM. For every scaffolded user (never `_global`) it:
 *   1. optionally rescans that user's own portals (`--scan`),
 *   2. ranks the pipeline against their profile (match-jobs.mjs),
 *   3. drops postings already announced, and postings the free ATS liveness
 *      check proves are dead,
 *   4. sends ONE Telegram message with the top matches and an Evaluate button
 *      per job.
 *
 * Isolation: every step runs against `users/<id>/` only, and the announced-job
 * ledger lives in that same folder — no user can see another's jobs, and the
 * digest cannot leak one user's pipeline into another's message.
 *
 * Talks to the Telegram HTTP API directly rather than through the bot process,
 * so the cron job neither needs nor disturbs the running poller.
 *
 * Usage:
 *   node daily-digest.mjs                 # all users, send for real
 *   node daily-digest.mjs --dry-run       # print what WOULD be sent
 *   node daily-digest.mjs --user <id>     # one user
 *   node daily-digest.mjs --scan          # rescan portals first (slow, ~2-5 min/user)
 *   node daily-digest.mjs --top 5         # jobs per digest (default 5)
 *   node daily-digest.mjs --min-score 40  # relevance floor (default 35)
 *
 * Cron (daily 07:00):
 *   0 7 * * * /bin/bash -lc 'cd ~/career-ops-agent && node daily-digest.mjs --scan >> ~/digest.log 2>&1'
 */

import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, USERS_DIR, GLOBAL_USER, buildUserEnv, isValidUserId } from './user-env.mjs';
import { checkLivenessViaApi, isAtsPosting } from './liveness-api.mjs';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const DO_SCAN = args.includes('--scan');
const argVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
};
const ONLY_USER = argVal('--user', null);
const TOP = Number(argVal('--top', 5));
const MIN_SCORE = Number(argVal('--min-score', 35));

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

/** Users the bot is allowed to serve at all. */
const ALLOWED = new Set((process.env.TELEGRAM_ALLOWED_IDS || '').split(',').map((s) => s.trim()).filter(Boolean));

// ---------------------------------------------------------------------------
// Announced-job ledger (per user, inside their own root)
// ---------------------------------------------------------------------------
const statePath = (root) => join(root, 'data', 'digest-state.json');

/**
 * Read a user's digest ledger.
 *
 * @param {string} root - The user's data root.
 * @returns {{sent: string[], lastRun: string|null, paused: boolean}}
 */
export function readState(root) {
  try {
    const s = JSON.parse(readFileSync(statePath(root), 'utf-8'));
    return { sent: Array.isArray(s.sent) ? s.sent : [], lastRun: s.lastRun || null, paused: !!s.paused };
  } catch { return { sent: [], lastRun: null, paused: false }; }
}

/**
 * Persist the ledger, keeping only the most recent URLs so it cannot grow
 * without bound on a daily cron.
 *
 * @param {string} root
 * @param {{sent: string[], lastRun?: string|null, paused?: boolean}} state
 */
export function writeState(root, state) {
  mkdirSync(join(root, 'data'), { recursive: true });
  const trimmed = { ...state, sent: (state.sent || []).slice(-500) };
  writeFileSync(statePath(root), `${JSON.stringify(trimmed, null, 2)}\n`);
}

/**
 * Jobs worth announcing: above the relevance floor and not announced before.
 *
 * @param {object[]} ranked - Output of match-jobs.mjs.
 * @param {string[]} alreadySent - URLs from the ledger.
 * @param {{top?: number, minScore?: number}} [opts]
 * @returns {object[]}
 */
export function selectNew(ranked, alreadySent, { top = TOP, minScore = MIN_SCORE } = {}) {
  const seen = new Set(alreadySent);
  return ranked.filter((j) => j.score >= minScore && !seen.has(j.url)).slice(0, top);
}

/**
 * Render the digest message. Plain text: job titles routinely contain
 * underscores, asterisks and brackets that would break Markdown parsing and
 * make Telegram reject the whole message.
 *
 * @param {object[]} jobs
 * @param {{name?: string, totalMatched?: number}} [ctx]
 * @returns {string}
 */
export function renderDigest(jobs, { name = '', totalMatched = 0 } = {}) {
  const head = `🌅 Good morning${name ? `, ${name.split(' ')[0]}` : ''} — ${jobs.length} new job${jobs.length === 1 ? '' : 's'} matching your profile`;
  const body = jobs.map((j, i) => {
    const why = j.reasons?.length ? `\n   ↳ ${j.reasons.slice(0, 3).join(' · ')}` : '';
    return `${i + 1}. ${j.title}\n   ${j.company}${j.location ? ` — ${j.location}` : ''} · fit ${j.score}/100${why}\n   ${j.url}`;
  }).join('\n\n');
  const tail = totalMatched > jobs.length
    ? `\n\n${totalMatched - jobs.length} more in /jobs. Tap a button to evaluate one now.`
    : '\n\nTap a button to evaluate one now.';
  return `${head}\n\n${body}${tail}`;
}

/**
 * One Evaluate button per job. callback_data is capped at 64 bytes by Telegram,
 * far too small for a URL, so it carries the ledger index and the bot resolves
 * it against digest-state.json.
 *
 * @param {object[]} jobs
 * @returns {{inline_keyboard: object[][]}}
 */
export function digestKeyboard(jobs) {
  return {
    inline_keyboard: jobs.map((j, i) => ([{
      text: `🔍 ${i + 1}. ${String(j.title).slice(0, 42)}`,
      callback_data: `digest_eval:${i}`,
    }])),
  };
}

/** POST to the Telegram Bot API. */
async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => null);
  if (!json?.ok) throw new Error(`Telegram ${method} failed: ${json?.description || `HTTP ${res.status}`}`);
  return json.result;
}

/**
 * Verify a posting is still open, using ONLY the free ATS API rung — no
 * browser. A cron that spun up Playwright per job would take hours and hammer
 * the boards. Anything unverifiable counts as alive: silently withholding a
 * real job is worse than showing one that just closed.
 *
 * @param {object[]} jobs
 * @returns {Promise<{live: object[], dead: object[]}>}
 */
export async function filterDead(jobs) {
  const live = [];
  const dead = [];
  for (const job of jobs) {
    if (!isAtsPosting(job.url)) { live.push(job); continue; }
    try {
      const verdict = await checkLivenessViaApi(job.url);
      if (verdict && verdict.status === 'expired') dead.push(job);
      else live.push(job);
    } catch { live.push(job); }
  }
  return { live, dead };
}

// ---------------------------------------------------------------------------
// Per-user run
// ---------------------------------------------------------------------------
async function runForUser(userId) {
  const root = join(USERS_DIR, userId);
  const env = { ...process.env, ...buildUserEnv(root) };
  const label = `[${userId}]`;

  const state = readState(root);
  if (state.paused) { console.log(`${label} digest paused — skipping.`); return { skipped: true }; }

  if (DO_SCAN) {
    console.log(`${label} scanning portals...`);
    try {
      execFileSync(process.execPath, [join(REPO_ROOT, 'scan.mjs')], { cwd: root, env, stdio: 'pipe', timeout: 900_000 });
      execFileSync(process.execPath, [join(REPO_ROOT, 'geo-policy.mjs')], { cwd: root, env, stdio: 'pipe', timeout: 120_000 });
    } catch (e) {
      console.error(`${label} scan failed (continuing with the existing pipeline): ${String(e.message).slice(0, 160)}`);
    }
  }

  // Rank in-process rather than shelling out: same module, no serialization.
  const { rankPipeline } = await import('./match-jobs.mjs');
  const { matches } = rankPipeline(root);
  const candidates = selectNew(matches, state.sent);
  if (candidates.length === 0) {
    console.log(`${label} nothing new above the fit floor (${matches.length} matched overall).`);
    writeState(root, { ...state, lastRun: new Date().toISOString() });
    return { sent: 0 };
  }

  const { live, dead } = await filterDead(candidates);
  if (dead.length) console.log(`${label} dropped ${dead.length} closed posting(s).`);
  if (live.length === 0) {
    writeState(root, { ...state, sent: [...state.sent, ...dead.map((j) => j.url)], lastRun: new Date().toISOString() });
    return { sent: 0 };
  }

  let name = '';
  try {
    const yaml = (await import('js-yaml')).default;
    name = (yaml.load(readFileSync(env.CAREER_OPS_PROFILE, 'utf-8')) || {}).candidate?.full_name || '';
  } catch { /* no name → generic greeting */ }

  const text = renderDigest(live, { name, totalMatched: matches.length });

  if (DRY_RUN) {
    console.log(`\n${label} ── would send ──────────────────────────────`);
    console.log(text);
    console.log(`${label} ── buttons: ${live.map((_, i) => `digest_eval:${i}`).join(', ')}\n`);
    return { sent: live.length, dryRun: true };
  }

  await tg('sendMessage', { chat_id: userId, text, reply_markup: digestKeyboard(live), disable_web_page_preview: true });

  // Record the offered list so the bot can resolve a button press back to a URL,
  // and so tomorrow's digest does not repeat today's jobs.
  writeState(root, {
    ...state,
    sent: [...state.sent, ...live.map((j) => j.url), ...dead.map((j) => j.url)],
    lastRun: new Date().toISOString(),
    offered: live.map((j) => ({ url: j.url, title: j.title, company: j.company })),
  });
  console.log(`${label} sent ${live.length} job(s).`);
  return { sent: live.length };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
// Compare against the ENTRY script, never against this module's own name:
// `import.meta.url.endsWith('daily-digest.mjs')` is true even when the module is
// imported, so the CLI ran — and sent real Telegram messages — the moment a test
// imported it for its pure helpers.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (!TOKEN && !DRY_RUN) {
    console.error('❌ TELEGRAM_BOT_TOKEN missing — cannot send. Use --dry-run to preview.');
    process.exit(1);
  }
  if (!existsSync(USERS_DIR)) {
    console.error('❌ No users/ directory — run scaffold-user.mjs first.');
    process.exit(1);
  }

  const all = readdirSync(USERS_DIR)
    .filter((d) => statSync(join(USERS_DIR, d)).isDirectory())
    .filter((d) => d !== GLOBAL_USER && isValidUserId(d));
  // Only ever message someone the bot is allowed to serve.
  const targets = (ONLY_USER ? all.filter((u) => u === ONLY_USER) : all)
    .filter((u) => ALLOWED.size === 0 || ALLOWED.has(u));

  if (targets.length === 0) {
    console.log('No eligible users (check TELEGRAM_ALLOWED_IDS and users/).');
    process.exit(0);
  }

  let total = 0;
  for (const u of targets) {
    try {
      const r = await runForUser(u);
      total += r.sent || 0;
    } catch (e) {
      console.error(`[${u}] digest failed: ${e.message}`);
    }
  }
  console.log(`\n✅ Digest run complete — ${total} job(s) pushed across ${targets.length} user(s).`);
}
