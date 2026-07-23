#!/usr/bin/env node

/**
 * find-contact-email.mjs — Family Edition Phase 5: resolve a person + company
 * into likely email addresses, with per-user Hunter.io credit awareness.
 *
 * Free by default: deterministic pattern guessing from name + domain, ranked
 * by how common each corporate pattern is. Optionally VERIFIES via a PER-USER
 * Hunter.io key (free tier ~50 searches/mo). The Hunter account endpoint (free,
 * consumes NO search credit) is checked first so we never fire a lookup when
 * the monthly quota is exhausted, and the used/limit count is always surfaced.
 *
 * Never sends email. No LinkedIn scraping (browser-extension paste is the
 * manual fallback). Feeds the draft-only outreach flow.
 *
 * Modes:
 *   --name "Jane Smith" (--domain acme.com | --company "Acme")   find an email
 *   --set-key <hunter_key>                                        save + validate
 *   --credits                                                     show usage
 *
 * Per-user key: config/profile.yml → integrations.hunter_api_key (or HUNTER_API_KEY).
 *
 * Markers: EMAIL_BEST · EMAIL_VERIFIED · EMAIL_ALTS · HUNTER_USED · HUNTER_LIMIT
 *          · HUNTER_SAVED
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const USER_ROOT = process.env.CAREER_OPS_USER_ROOT
  ? resolve(process.env.CAREER_OPS_USER_ROOT)
  : process.cwd();
const PROFILE_PATH = process.env.CAREER_OPS_PROFILE || join(USER_ROOT, 'config', 'profile.yml');

/** Split a full name into normalized { first, last } (ascii letters only). */
export function parseName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '');
  const first = norm(parts[0]);
  const last = parts.length > 1 ? norm(parts[parts.length - 1]) : '';
  return first ? { first, last } : null;
}

/** Resolve a company name OR domain into a best-guess email domain. Exported. */
export function deriveDomain(companyOrDomain) {
  let s = String(companyOrDomain || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return s;
  const cleaned = s
    .replace(/[,.]/g, ' ')
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|technologies|technology|solutions|systems|group|labs|holdings|international|intl|the|a|an)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '');
  return cleaned ? `${cleaned}.com` : '';
}

/** Generate candidate emails ordered most-common-first. Exported. */
export function generatePatterns(first, last, domain) {
  if (!first || !domain) return [];
  const f = first[0] || '';
  const l = last[0] || '';
  const locals = last
    ? [`${first}.${last}`, `${f}${last}`, `${first}${last}`, `${first}`, `${first}_${last}`, `${f}.${last}`, `${first}${l}`, `${last}.${first}`, `${last}${f}`]
    : [`${first}`];
  const seen = new Set();
  return locals.filter((p) => p && !seen.has(p) && seen.add(p)).map((p) => `${p}@${domain}`);
}

/** Read the per-user Hunter key (profile.yml integrations, then env). */
export function loadHunterKey() {
  if (existsSync(PROFILE_PATH)) {
    try {
      const doc = yaml.load(readFileSync(PROFILE_PATH, 'utf-8')) || {};
      const k = doc.integrations?.hunter_api_key;
      if (k && String(k).trim()) return String(k).trim();
    } catch { /* fall through */ }
  }
  return process.env.HUNTER_API_KEY || '';
}

/** Persist a Hunter key into profile.yml (comment-preserving line edit). Exported. */
export function writeHunterKey(profilePath, key) {
  const clean = String(key || '').replace(/"/g, '').trim();
  let text = existsSync(profilePath) ? readFileSync(profilePath, 'utf-8') : '';
  const line = `  hunter_api_key: "${clean}"`;
  if (/^\s*hunter_api_key:.*$/m.test(text)) {
    text = text.replace(/^\s*hunter_api_key:.*$/m, line);
  } else if (/^integrations:\s*$/m.test(text)) {
    text = text.replace(/^integrations:\s*$/m, `integrations:\n${line}`);
  } else {
    text = `${text.replace(/\s*$/, '')}\n\nintegrations:\n${line}\n`;
  }
  writeFileSync(profilePath, text);
}

/** Parse Hunter's /v2/account response into { used, available, limit, resetDate }. Exported. */
export function parseAccount(json) {
  const d = json?.data;
  if (!d) return null;
  const s = d.requests?.searches || d.calls;
  if (!s) return null;
  const used = Number(s.used) || 0;
  const available = s.available != null ? Number(s.available) : null;
  const limit = available != null ? used + available : (s.limit != null ? Number(s.limit) : null);
  return { used, available, limit, resetDate: d.reset_date || null };
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, { redirect: 'error', signal: controller.signal });
    return { ok: res.ok, json: await res.json().catch(() => null) };
  } catch {
    return { ok: false, json: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Hunter account usage (free — no search credit consumed). */
async function hunterAccount(key) {
  const { json } = await fetchJson(`https://api.hunter.io/v2/account?api_key=${encodeURIComponent(key)}`);
  return parseAccount(json);
}

/** Hunter email-finder (consumes one search credit). */
async function hunterFind(domain, first, last, key) {
  const u = new URL('https://api.hunter.io/v2/email-finder');
  u.searchParams.set('domain', domain);
  u.searchParams.set('first_name', first);
  if (last) u.searchParams.set('last_name', last);
  u.searchParams.set('api_key', key);
  const { json } = await fetchJson(u.toString());
  const email = json?.data?.email;
  return email ? { email, score: json.data.score ?? null } : null;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

  const usageLine = (a) => a ? `${a.used}/${a.limit ?? '?'} searches used this month${a.resetDate ? ` (resets ${a.resetDate})` : ''}` : 'usage unavailable';

  // --- --set-key: validate against the account endpoint, then persist -------
  const setKey = get('--set-key');
  if (setKey) {
    const acct = await hunterAccount(setKey);
    if (!acct) {
      console.error('❌ That Hunter.io key was rejected (could not read the account). Double-check it and try again.');
      process.exit(1);
    }
    writeHunterKey(PROFILE_PATH, setKey);
    console.log(`✅ Hunter.io key saved. ${usageLine(acct)}`);
    console.log('HUNTER_SAVED: yes');
    console.log(`HUNTER_USED: ${acct.used}`);
    console.log(`HUNTER_LIMIT: ${acct.limit ?? ''}`);
    process.exit(0);
  }

  // --- --credits: show current usage ---------------------------------------
  if (args.includes('--credits')) {
    const key = loadHunterKey();
    if (!key) { console.log('ℹ️ No Hunter.io key on file. Add one to verify contact emails (free 50/mo).'); process.exit(0); }
    const acct = await hunterAccount(key);
    console.log(acct ? `📊 Hunter.io: ${usageLine(acct)}` : '⚠️ Could not reach Hunter.io to read usage.');
    if (acct) { console.log(`HUNTER_USED: ${acct.used}`); console.log(`HUNTER_LIMIT: ${acct.limit ?? ''}`); }
    process.exit(0);
  }

  // --- default: find an email ----------------------------------------------
  const name = get('--name');
  const domainArg = get('--domain');
  const company = get('--company');
  if (!name || (!domainArg && !company)) {
    console.error('Usage: node find-contact-email.mjs --name "First Last" (--domain acme.com | --company "Acme") | --set-key <key> | --credits');
    process.exit(2);
  }
  const person = parseName(name);
  if (!person) { console.error(`❌ Could not parse a name from "${name}"`); process.exit(1); }
  const domain = deriveDomain(domainArg || company);
  if (!domain) { console.error('❌ Could not determine an email domain — pass --domain explicitly.'); process.exit(1); }
  const domainGuessed = !domainArg;

  const patterns = generatePatterns(person.first, person.last, domain);

  // Hunter path — check quota (free) before spending a search credit.
  let verified = null;
  let acct = null;
  const key = loadHunterKey();
  if (key) {
    acct = await hunterAccount(key);
    if (acct && (acct.available === null || acct.available > 0)) {
      verified = await hunterFind(domain, person.first, person.last, key);
      acct = await hunterAccount(key); // refresh count after the lookup
    }
  }

  const best = verified?.email || patterns[0] || '';
  const alts = patterns.filter((p) => p !== best).slice(0, 4);

  console.log(`\n📇 Likely email for ${name} @ ${domain}${domainGuessed ? ' (domain guessed)' : ''}`);
  if (verified) console.log(`   ✅ Verified via Hunter (confidence ${verified.score ?? '?'}): ${verified.email}`);
  else if (key && acct && acct.available === 0) console.log('   ⚠️ Hunter quota exhausted for this month — pattern guesses only.');
  else if (key) console.log('   ⚠️ Hunter had no confident match — pattern guesses.');
  else console.log('   ℹ️ No Hunter key on file — pattern guesses only.');
  console.log('   Best guess: ' + best);
  if (alts.length) console.log('   Alternatives: ' + alts.join('  |  '));
  if (acct) console.log(`   🔑 Hunter: ${usageLine(acct)}`);

  console.log(`\nEMAIL_BEST: ${best}`);
  console.log(`EMAIL_VERIFIED: ${verified ? 'yes' : 'no'}`);
  console.log(`EMAIL_ALTS: ${alts.join('; ')}`);
  if (acct) { console.log(`HUNTER_USED: ${acct.used}`); console.log(`HUNTER_LIMIT: ${acct.limit ?? ''}`); }
}
