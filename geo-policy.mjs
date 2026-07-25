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
// NOT remote has to be in one of these; anywhere else in Canada is a drop even
// though the country matches. Metro spellings are included because boards label
// the same office a dozen ways ("Toronto, ON", "Greater Toronto Area",
// "North York"). Deliberately conservative: a suburb only appears here when it
// is unambiguously that metro.
// Owner list (2026-07-25): Vancouver, Calgary, Toronto + Ottawa, Kitchener,
// Waterloo, Montreal. "Waterloo" is safe here even though it collides with
// Waterloo, Iowa/Belgium — this test only runs AFTER detectCountry() has already
// resolved the row to Canada, so a US Waterloo never reaches it.
const HYBRID_CITY_RE = /\b(vancouver|calgary|toronto|greater toronto|gta|north york|etobicoke|scarborough|downtown toronto|greater vancouver|downtown vancouver|ottawa|kitchener|waterloo|kitchener[ -]waterloo|montr[eé]al|greater montr[eé]al)\b/i;

// India (Phase 8 toggle). Broad on purpose — this is DETECTION ("is this row in
// India?"), so a Mumbai posting must resolve to IN and then be dropped by the
// hub-city rule below, rather than falling through to "outside North America"
// and being dropped for the wrong reason. Checked BEFORE the two-letter code
// rule, since "IN" also means Indiana.
const IN_RE = /\b(india|bengaluru|bangalore|hyderabad|mumbai|pune|chennai|gurgaon|gurugram|noida|kolkata|ahmedabad|gandhinagar|delhi|kochi|coimbatore|indore|jaipur|thiruvananthapuram|trivandrum)\b/i;

// The only Indian cities the owner would take a non-remote role in
// (owner list 2026-07-25). Mirrors HYBRID_CITY_RE: India has to be switched on
// AND the role has to be remote or in one of these. Both spellings of Bengaluru
// are listed because boards use them interchangeably.
const IN_HUB_RE = /\b(ahmedabad|gandhinagar|bengaluru|bangalore)\b/i;

// Indian cities that are NOT hubs. Used to tell "Mumbai, India" (a real
// non-hub city → drop) apart from a bare "India" with no city named, which is
// how Adzuna India labels most of its rows and which the owner wants KEPT
// (2026-07-25) rather than discarded for lacking a city.
const IN_NON_HUB_CITY_RE = /\b(hyderabad|mumbai|pune|chennai|gurgaon|gurugram|noida|kolkata|delhi|kochi|coimbatore|indore|jaipur|thiruvananthapuram|trivandrum)\b/i;

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
    // Remote is location-independent, so it needs no city. Otherwise the same
    // rule as Canada: only the owner's hub cities.
    if (remote) return { keep: true, reason: 'India (remote)', rank: 0 };
    const loc = String(location || '');
    if (IN_HUB_RE.test(loc)) return { keep: true, reason: 'India hybrid/on-site (hub city)', rank: 3 };
    // A row that names an actual non-hub city is a drop; one that names NO city
    // (bare "India") is kept — country-only is how Adzuna India labels most
    // postings, and dropping those would discard nearly every India result.
    if (IN_NON_HUB_CITY_RE.test(loc)) return { keep: false, reason: 'India on-site outside hub cities', rank: 9 };
    return { keep: true, reason: 'India (city unstated)', rank: 3 };
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
 * Read this user's `priority_titles` and `min_salary` from portals.yml.
 * Both are optional: no priority list means every row is one tier, and no
 * salary floor means no salary filtering.
 *
 * @param {string} [portalsPath]
 * @returns {{priorityTitles: string[], minSalary: number|null}}
 */
export function readRankingPrefs(portalsPath) {
  const p = portalsPath || process.env.CAREER_OPS_PORTALS || join(USER_ROOT, 'portals.yml');
  try {
    if (!existsSync(p)) return { priorityTitles: [], minSalary: null };
    const cfg = yaml.load(readFileSync(p, 'utf-8')) || {};
    const list = Array.isArray(cfg.priority_titles) ? cfg.priority_titles.filter((t) => typeof t === 'string') : [];
    const sal = Number(cfg.min_salary);
    return { priorityTitles: list, minSalary: Number.isFinite(sal) && sal > 0 ? sal : null };
  } catch { return { priorityTitles: [], minSalary: null }; }
}

/** Significant words of a title — drops filler that carries no matching signal. */
const TITLE_FILLER = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'in', 'at', 'for', 'to', 'with', 'i', 'ii', 'iii']);
function titleWords(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#/]+/g, ' ')
    .split(' ')
    .filter((w) => w && !TITLE_FILLER.has(w));
}

/**
 * Is this posting title one of the user's priority roles?
 *
 * A priority entry matches when EVERY significant word of it appears somewhere
 * in the posting title, in any order. Word-set containment rather than substring
 * because real postings reorder and pad titles: "Senior QA Engineer" has to
 * match "Senior QA Engineer, Platform" and "QA Engineer (Senior)", while still
 * NOT matching a bare "QA Engineer" — the owner listed the senior form on
 * purpose. Exported for tests.
 *
 * @param {string} title            Posting title.
 * @param {string[]} priorityTitles The user's `priority_titles`.
 * @returns {boolean}
 */
export function isPriorityTitle(title, priorityTitles = []) {
  const words = new Set(titleWords(title));
  if (words.size === 0) return false;
  return priorityTitles.some((p) => {
    const want = titleWords(p);
    return want.length > 0 && want.every((w) => words.has(w));
  });
}

/**
 * Lowest annual salary mentioned in a compensation string, normalized to whole
 * currency units, or null when the row states no usable figure.
 *
 * Handles "$85,000 - $110,000", "CAD 90000", "$45/hour" (annualized at 2080h),
 * and "85k-110k". Returns null — never 0 — for "Competitive" or an empty cell,
 * so a missing salary can be KEPT rather than filtered out as too low.
 * Exported for tests.
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
export function parseSalaryFloor(raw) {
  const s = String(raw ?? '').toLowerCase();
  if (!s.trim()) return null;
  const hourly = /\b(?:per\s*hour|hourly|\/\s*h(?:r|our)?|an hour)\b/.test(s);
  const values = [];
  const re = /(\d[\d,.]*)\s*(k\b)?/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    let n = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    if (m[2]) n *= 1000;                       // "85k"
    if (hourly && n > 0 && n < 500) n *= 2080; // hourly → annual
    // Ignore stray small numbers (years of experience, "401k" style noise).
    if (n >= 10_000) values.push(n);
  }
  return values.length ? Math.min(...values) : null;
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
  // Compensation is the optional 5th positional cell (scan.mjs writes it when a
  // board reports pay). Identified by content, not index: the labeled `posted:`
  // segment can occupy that slot when no salary was reported.
  const compensation = parts.slice(4).find((p) => p && !/^posted:/i.test(p)) || '';
  return {
    url: parts[0] || '', company: parts[1] || '', title: parts[2] || '',
    location: parts[3] || '', posted, compensation,
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
  let underpaid = 0;
  const includeIndia = indiaEnabled();
  const maxAge = maxPostingAgeDays();
  const { priorityTitles, minSalary } = readRankingPrefs();
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
    // Salary floor: only drop when the posting STATES a figure below it. A row
    // with no salary is kept (most boards report none, and silence is not a
    // low offer) — the owner's explicit rule.
    if (minSalary !== null) {
      const floor = parseSalaryFloor(row.compensation);
      if (floor !== null && floor < minSalary) {
        underpaid += 1;
        const key = `Below ${minSalary.toLocaleString()} salary floor`;
        reasons[key] = (reasons[key] || 0) + 1;
        continue;
      }
    }
    // Dedup identical postings that arrive under different URLs (e.g. Adzuna's
    // per-request se= token, or the same job cross-listed on two boards).
    const fp = `${row.company}|${row.title}|${row.location}`.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(fp)) { deduped += 1; continue; }
    seen.add(fp);
    kept.push({
      line,
      rank: c.rank,
      posted: row.posted,
      // Tier 0 = one of this user's priority roles, 1 = everything else.
      tier: priorityTitles.length && isPriorityTitle(row.title, priorityTitles) ? 0 : 1,
    });
  }
  // Ordering, in precedence order:
  //   1. priority tier — the user's target roles form a block at the top, so the
  //      jobs they actually want are never buried under fresher near-misses.
  //      With no priority_titles configured every row is tier 1 and this term
  //      vanishes, leaving the previous pure newest-first behaviour untouched.
  //   2. newest posted first — the reading order, preserved WITHIN each tier.
  //   3. geography rank, breaking ties inside a single day.
  // Undated rows sort after dated ones (an unknown date is not evidence of
  // freshness).
  kept.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.posted && b.posted && a.posted !== b.posted) return a.posted < b.posted ? 1 : -1;
    if (a.posted && !b.posted) return -1;
    if (!a.posted && b.posted) return 1;
    return a.rank - b.rank;
  });
  const priorityCount = kept.filter((k) => k.tier === 0).length;

  // Trim trailing blank header lines, then re-emit header + sorted kept rows.
  while (header.length && header[header.length - 1].trim() === '') header.pop();
  const out = `${header.join('\n')}\n\n${kept.map((k) => k.line).join('\n')}\n`;
  writeFileSync(pipelinePath, out);

  if (asJson) {
    console.log(JSON.stringify({ kept: kept.length, dropped, deduped, stale, underpaid, priority: priorityCount, reasons }));
  } else {
    console.log(`🌎 Geo-policy: kept ${kept.length} (${priorityCount} priority-role first, then newest), dropped ${dropped}, stale ${stale}, underpaid ${underpaid}, deduped ${deduped}`);
    for (const [r, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
      console.log(`   ${n.toString().padStart(4)} · ${r}`);
    }
  }
}
