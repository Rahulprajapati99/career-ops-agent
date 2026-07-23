#!/usr/bin/env node

/**
 * find-contact-email.mjs — Family Edition Phase 5: resolve a person + company
 * into likely email addresses.
 *
 * Free by default: deterministic pattern guessing from name + domain, ranked
 * by how common each corporate pattern is. Optionally VERIFIES / discovers via
 * a per-user Hunter.io key (free tier ~25-50 lookups/mo) when one is on file.
 *
 * This tool NEVER sends email — it only surfaces addresses for the human to use
 * with the draft-only `email` mode. No LinkedIn scraping; a browser-extension
 * paste is the manual fallback when patterns/Hunter come up short.
 *
 * Usage:
 *   node find-contact-email.mjs --name "Jane Smith" --domain acme.com
 *   node find-contact-email.mjs --name "Jane Smith" --company "Acme Corp"
 *
 * Per-user key: config/profile.yml → integrations.hunter_api_key
 *   (or the HUNTER_API_KEY env var).
 *
 * Output markers (for the Telegram bot / web dashboard):
 *   EMAIL_BEST: <best guess or verified email>
 *   EMAIL_VERIFIED: <yes|no>
 *   EMAIL_ALTS: <alt1; alt2; alt3>
 */

import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const USER_ROOT = process.env.CAREER_OPS_USER_ROOT
  ? resolve(process.env.CAREER_OPS_USER_ROOT)
  : process.cwd();

/** Split a full name into normalized { first, last } (ascii letters only). */
export function parseName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '');
  const first = norm(parts[0]);
  const last = parts.length > 1 ? norm(parts[parts.length - 1]) : '';
  return first ? { first, last } : null;
}

/**
 * Resolve a company name OR a domain into a best-guess email domain. A value
 * that already looks like a domain is returned as-is (host only); otherwise
 * legal suffixes and filler words are stripped and ".com" is appended.
 * Exported for tests.
 */
export function deriveDomain(companyOrDomain) {
  let s = String(companyOrDomain || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return s; // already a domain/host
  const cleaned = s
    .replace(/[,.]/g, ' ')
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|technologies|technology|solutions|systems|group|labs|holdings|international|intl|the|a|an)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '');
  return cleaned ? `${cleaned}.com` : '';
}

/**
 * Generate candidate emails ordered most-common-first. Exported for tests.
 * @returns {string[]}
 */
export function generatePatterns(first, last, domain) {
  if (!first || !domain) return [];
  const f = first[0] || '';
  const l = last[0] || '';
  const locals = last
    ? [`${first}.${last}`, `${f}${last}`, `${first}${last}`, `${first}`, `${first}_${last}`, `${f}.${last}`, `${first}${l}`, `${last}.${first}`, `${last}${f}`]
    : [`${first}`];
  const seen = new Set();
  return locals
    .filter((p) => p && !seen.has(p) && seen.add(p))
    .map((p) => `${p}@${domain}`);
}

/** Read the per-user Hunter key (profile.yml integrations, then env). */
export function loadHunterKey(userRoot) {
  const profilePath = process.env.CAREER_OPS_PROFILE || join(userRoot, 'config', 'profile.yml');
  if (existsSync(profilePath)) {
    try {
      const doc = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
      const k = doc.integrations?.hunter_api_key;
      if (k && String(k).trim()) return String(k).trim();
    } catch { /* fall through */ }
  }
  return process.env.HUNTER_API_KEY || '';
}

/** Hunter.io email-finder. Returns { email, score } or null. */
async function hunterFind(domain, first, last, key) {
  const u = new URL('https://api.hunter.io/v2/email-finder');
  u.searchParams.set('domain', domain);
  u.searchParams.set('first_name', first);
  if (last) u.searchParams.set('last_name', last);
  u.searchParams.set('api_key', key);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(u, { redirect: 'error', signal: controller.signal });
    const json = await res.json().catch(() => null);
    const email = json?.data?.email;
    if (email) return { email, score: json.data.score ?? null };
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
  const name = get('--name');
  const domainArg = get('--domain');
  const company = get('--company');

  if (!name || (!domainArg && !company)) {
    console.error('Usage: node find-contact-email.mjs --name "First Last" (--domain acme.com | --company "Acme")');
    process.exit(2);
  }

  const person = parseName(name);
  if (!person) {
    console.error(`❌ Could not parse a name from "${name}"`);
    process.exit(1);
  }
  const domain = deriveDomain(domainArg || company);
  if (!domain) {
    console.error('❌ Could not determine an email domain — pass --domain explicitly.');
    process.exit(1);
  }
  const domainGuessed = !domainArg;

  const patterns = generatePatterns(person.first, person.last, domain);

  // Optional Hunter verification/discovery.
  let verified = null;
  const key = loadHunterKey(USER_ROOT);
  if (key) {
    console.log('🔎 Checking Hunter.io (per-user key)...');
    verified = await hunterFind(domain, person.first, person.last, key);
  }

  const best = verified?.email || patterns[0] || '';
  const alts = patterns.filter((p) => p !== best).slice(0, 4);

  console.log(`\n📇 Likely email for ${name} @ ${domain}${domainGuessed ? ' (domain guessed)' : ''}`);
  if (verified) {
    console.log(`   ✅ Verified (Hunter, confidence ${verified.score ?? '?'}): ${verified.email}`);
  } else if (key) {
    console.log('   ⚠️ Hunter had no confident match — falling back to pattern guesses.');
  } else {
    console.log('   ℹ️ No Hunter key on file — pattern guesses only (add integrations.hunter_api_key to verify).');
  }
  console.log('   Best guess: ' + best);
  if (alts.length) console.log('   Alternatives: ' + alts.join('  |  '));
  console.log('\n   Verify before sending: patterns are educated guesses. The `email` mode drafts — you always review & send.');

  console.log(`\nEMAIL_BEST: ${best}`);
  console.log(`EMAIL_VERIFIED: ${verified ? 'yes' : 'no'}`);
  console.log(`EMAIL_ALTS: ${alts.join('; ')}`);
}
