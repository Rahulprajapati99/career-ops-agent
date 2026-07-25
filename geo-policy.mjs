#!/usr/bin/env node

/**
 * geo-policy.mjs — Family Edition: apply a per-user geography policy to the
 * scanned pipeline (runs after scan.mjs, rewrites data/pipeline.md in place).
 *
 * Policy (owner decision 2026-07-24), tuned for a CANADIAN worker:
 *   - REMOTE, anywhere in Canada (every province) ............... KEEP
 *   - Canada on-site / hybrid, in Vancouver / Calgary / Toronto . KEEP
 *   - Canada on-site / hybrid, any OTHER city ................... DROP
 *   - US, REMOTE only ........................................... KEEP
 *   - US on-site / hybrid ....................................... DROP
 *   - India, ANY modality — only with the India toggle on ....... KEEP
 *   - Outside those .............................................. DROP
 *   - Location unknown/blank .................................... KEEP (don't
 *     penalize missing data — same convention as scan.mjs)
 *
 * Survivors are ordered NEWEST POSTED FIRST (the owner reads the top of the
 * list), with the geography rank above as the tie-breaker within a single day
 * and for postings a provider gave no date for.
 *
 * Rows whose posting date has aged past `max_posting_age_days` (portals.yml,
 * default 7) are pruned here too. scan.mjs only applies that cutoff at INSERT
 * time, so without this pass a pipeline that is rescanned daily keeps showing
 * postings that were fresh a fortnight ago.
 *
 * Country detection is robust: full country/state/province names, trailing
 * two-letter codes ("Austin, TX" / "Toronto, ON"), and major NA cities.
 *
 * Usage:  node geo-policy.mjs            (reads CAREER_OPS_USER_ROOT)
 *         node geo-policy.mjs --json     (machine-readable summary)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const USER_ROOT = process.env.CAREER_OPS_USER_ROOT
  ? resolve(process.env.CAREER_OPS_USER_ROOT)
  : process.cwd();

// House rule: the pipeline only ever shows the last week of postings.
export const DEFAULT_MAX_POSTING_AGE_DAYS = 7;

const US_STATE_NAMES = ['alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming'];
const US_CODES = new Set(['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC']);
const CA_CODES = new Set(['ON', 'QC', 'BC', 'AB', 'MB', 'SK', 'NS', 'NB', 'NL', 'PE', 'YT', 'NT', 'NU']);
// Province names + distinctive city names only. Collision-prone city names
// (Hamilton, Waterloo, Victoria, London — all also US/other places) are left
// out; "City, ON"-style province codes catch those Canadian cities reliably.
const CA_RE = /\b(canada|ontario|qu[eé]bec|british columbia|alberta|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland|prince edward|toronto|vancouver|montr[eé]al|calgary|ottawa|edmonton|winnipeg|mississauga|kitchener|halifax|scarborough|brampton|markham)\b/i;
const US_RE = /\b(united states|u\.?s\.?a?\.?|u\.s\.)\b/i;
// How remote roles are labeled across boards: explicit "remote", remote-board
// region tags ("Worldwide", "Anywhere", "USA Only", "Americas"), and synonyms.
const REMOTE_RE = /\bremote\b|\bwfh\b|work[ -]?from[ -]?home|\banywhere\b|\bworldwide\b|\bglobal\b|\bdistributed\b|\btelecommute\b|\bvirtual\b|home[ -]?based|\b(?:us|usa|u\.s\.?)\s+only\b|\bnorth america\b|\bamericas\b/i;

// The only Canadian cities the owner will commute to. A Canadian role that is
// NOT remote has to be in one of these three; anywhere else in Canada is a drop
// even though the country matches. Metro spellings are included because boards
// label the same office a dozen ways ("Toronto, ON", "Greater Toronto Area",
// "North York"). Deliberately conservative: a suburb only appears here when it
// is unambiguously that metro.
const HYBRID_CITY_RE = /\b(vancouver|calgary|toronto|greater toronto|gta|north york|etobicoke|scarborough|downtown toronto|greater vancouver|downtown vancouver)\b/i;

// India (Phase 8 toggle). Major tech hubs + the country name; deliberately
// checked BEFORE the two-letter code rule, since "IN" also means Indiana.
const IN_RE = /\b(india|bengaluru|bangalore|hyderabad|mumbai|pune|chennai|gurgaon|gurugram|noida|kolkata|ahmedabad|delhi|kochi|coimbatore|indore|jaipur|thiruvananthapuram|trivandrum)\b/i;

/** Classify a location string as 'CA' | 'US' | 'IN' | null (unknown/other). Exported. */
export function detectCountry(location) {
  const loc = String(location || '');
  if (!loc.trim()) return null;
  const low = loc.toLowerCase();
  if (CA_RE.test(low)) return 'CA';
  if (IN_RE.test(low)) return 'IN';
  if (US_RE.test(low)) return 'US';
  const codeMatch = loc.match(/,\s*([A-Za-z]{2})\b(?![A-Za-z.])/);
  if (codeMatch) {
    const code = codeMatch[1].toUpperCase();
    if (CA_CODES.has(code)) return 'CA';
    if (US_CODES.has(code)) return 'US';
  }
  if (US_STATE_NAMES.some((s) => low.includes(s))) return 'US';
  return null;
}

/**
 * Decide keep/drop + priority rank for one posting.
 *
 * rank is the TIE-BREAKER only — the pipeline is ordered newest-posted-first.
 * 0 = remote (any province, or US-remote), 1 = Canada hybrid/on-site in one of
 * the three commutable cities, 2 = unknown location, 3 = India on-site (only
 * when the India toggle is on).
 *
 * @param {{title?: string, location?: string}} row
 * @param {{includeIndia?: boolean}} [opts] - Phase 8 toggle. Off by default, so
 *   the North-America-only policy is unchanged unless a user opts in.
 * @returns {{ keep: boolean, reason: string, rank: number }}
 */
export function classifyRow({ title, location }, { includeIndia = false } = {}) {
  const remote = REMOTE_RE.test(String(location || '')) || REMOTE_RE.test(String(title || ''));
  const country = detectCountry(location);
  // An India-remote role is still an India role: without the toggle it must not
  // slip in through the remote fast-path.
  if (country === 'IN') {
    if (!includeIndia) return { keep: false, reason: 'India (toggle off)', rank: 9 };
    return { keep: true, reason: remote ? 'India (remote)' : 'India (on-site/hybrid)', rank: remote ? 0 : 3 };
  }
  // Remote (Canada-remote, US-remote, or region/worldwide-remote) is top priority.
  if (remote) return { keep: true, reason: 'Remote', rank: 0 };
  if (country === 'CA') {
    // Canada, but someone has to physically go in: only the three hub cities.
    return HYBRID_CITY_RE.test(String(location || ''))
      ? { keep: true, reason: 'Canada hybrid/on-site (hub city)', rank: 1 }
      : { keep: false, reason: 'Canada on-site outside hub cities', rank: 9 };
  }
  if (country === 'US') return { keep: false, reason: 'US on-site (excluded)', rank: 9 };
  if (!String(location || '').trim()) return { keep: true, reason: 'Location unknown', rank: 2 };
  return { keep: false, reason: 'Outside North America', rank: 9 };
}

/**
 * Max posting age, in days, from the user's portals.yml. Defaults to 7 — the
 * global house rule is a one-week-old pipeline, so a user file that predates
 * the key still gets the cutoff.
 *
 * @param {string} [portalsPath]
 * @returns {number}
 */
export function maxPostingAgeDays(portalsPath) {
  const p = portalsPath || process.env.CAREER_OPS_PORTALS || join(USER_ROOT, 'portals.yml');
  try {
    if (!existsSync(p)) return DEFAULT_MAX_POSTING_AGE_DAYS;
    const raw = (yaml.load(readFileSync(p, 'utf-8')) || {}).max_posting_age_days;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_POSTING_AGE_DAYS;
  } catch { return DEFAULT_MAX_POSTING_AGE_DAYS; }
}

/**
 * Age a `posted: YYYY-MM-DD` stamp in whole days, or null when the row carries
 * no date. Exported for tests (`now` is injectable).
 *
 * @param {string|null} posted
 * @param {number} [now]
 * @returns {number|null}
 */
export function postedAgeDays(posted, now = Date.now()) {
  if (!posted) return null;
  const t = Date.parse(`${posted}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return Math.floor((now - t) / 86_400_000);
}

/**
 * Whether this user opted into Indian postings (Phase 8).
 * Lives in the user's own portals.yml, so each family member chooses
 * independently and the default stays North-America-only.
 *
 * @param {string} [portalsPath]
 * @returns {boolean}
 */
export function indiaEnabled(portalsPath) {
  const p = portalsPath || process.env.CAREER_OPS_PORTALS || join(USER_ROOT, 'portals.yml');
  try {
    if (!existsSync(p)) return false;
    return (yaml.load(readFileSync(p, 'utf-8')) || {}).include_india === true;
  } catch { return false; }
}

/** Parse a pipeline `- [ ] url | company | title | location | posted: date` row. */
export function parsePipelineRow(line) {
  const m = line.match(/^- \[ \]\s*(.+)$/);
  if (!m) return null;
  const parts = m[1].split('|').map((s) => s.trim());
  // `posted:` is a LABELED segment (scan.mjs appends it after the positional
  // cells), so find it by label rather than by index — compensation and note
  // shift the trailing columns around.
  const posted = parts
    .map((p) => p.match(/^posted:\s*(\d{4}-\d{2}-\d{2})$/i)?.[1])
    .find(Boolean) || null;
  return {
    url: parts[0] || '', company: parts[1] || '', title: parts[2] || '',
    location: parts[3] || '', posted,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const asJson = process.argv.includes('--json');
  const pipelinePath = join(USER_ROOT, 'data', 'pipeline.md');
  if (!existsSync(pipelinePath)) {
    console.log(asJson ? '{"kept":0,"dropped":0,"note":"no pipeline"}' : 'geo-policy: no pipeline.md to filter.');
    process.exit(0);
  }

  const lines = readFileSync(pipelinePath, 'utf-8').split('\n');
  const header = [];
  const rows = [];
  let seenRow = false;
  for (const line of lines) {
    const row = parsePipelineRow(line);
    if (row) { seenRow = true; rows.push({ line, row }); }
    else if (!seenRow) header.push(line); // preamble before the first row
    // non-row lines after rows (trailing blanks) are dropped
  }

  const reasons = {};
  const kept = [];
  const seen = new Set();
  let dropped = 0;
  let deduped = 0;
  let stale = 0;
  const includeIndia = indiaEnabled();
  const maxAge = maxPostingAgeDays();
  for (const { line, row } of rows) {
    // Freshness first: an aged-out posting is not worth classifying. Rows with
    // no date always survive — same "don't penalize missing data" convention.
    const age = postedAgeDays(row.posted);
    if (age !== null && age > maxAge) {
      stale += 1;
      reasons[`Older than ${maxAge} days`] = (reasons[`Older than ${maxAge} days`] || 0) + 1;
      continue;
    }
    const c = classifyRow(row, { includeIndia });
    reasons[c.reason] = (reasons[c.reason] || 0) + 1;
    if (!c.keep) { dropped += 1; continue; }
    // Dedup identical postings that arrive under different URLs (e.g. Adzuna's
    // per-request se= token, or the same job cross-listed on two boards).
    const fp = `${row.company}|${row.title}|${row.location}`.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(fp)) { deduped += 1; continue; }
    seen.add(fp);
    kept.push({ line, rank: c.rank, posted: row.posted });
  }
  // Newest posted first — what the owner actually reads down. Undated rows sort
  // after every dated one (an unknown date is not evidence of freshness), and
  // the geography rank breaks ties inside a single day.
  kept.sort((a, b) => {
    if (a.posted && b.posted && a.posted !== b.posted) return a.posted < b.posted ? 1 : -1;
    if (a.posted && !b.posted) return -1;
    if (!a.posted && b.posted) return 1;
    return a.rank - b.rank;
  });

  // Trim trailing blank header lines, then re-emit header + sorted kept rows.
  while (header.length && header[header.length - 1].trim() === '') header.pop();
  const out = `${header.join('\n')}\n\n${kept.map((k) => k.line).join('\n')}\n`;
  writeFileSync(pipelinePath, out);

  if (asJson) {
    console.log(JSON.stringify({ kept: kept.length, dropped, deduped, stale, reasons }));
  } else {
    console.log(`🌎 Geo-policy: kept ${kept.length} (newest first), dropped ${dropped}, stale ${stale}, deduped ${deduped}`);
    for (const [r, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
      console.log(`   ${n.toString().padStart(4)} · ${r}`);
    }
  }
}
