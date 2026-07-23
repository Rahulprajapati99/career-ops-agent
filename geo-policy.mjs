#!/usr/bin/env node

/**
 * geo-policy.mjs — Family Edition: apply a per-user geography policy to the
 * scanned pipeline (runs after scan.mjs, rewrites data/pipeline.md in place).
 *
 * Policy (owner decision 2026-07-23), tuned for a CANADIAN worker:
 *   - Canada, ANY modality (on-site / hybrid / remote) ........... KEEP
 *   - US, REMOTE only ........................................... KEEP
 *   - US on-site / hybrid ....................................... DROP
 *   - Outside North America ..................................... DROP
 *   - Location unknown/blank .................................... KEEP (don't
 *     penalize missing data — same convention as scan.mjs)
 *
 * The surviving jobs are REORDERED so remote roles sit at the top of the
 * pipeline (highest priority), then Canada on-site/hybrid, then unknowns.
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

const USER_ROOT = process.env.CAREER_OPS_USER_ROOT
  ? resolve(process.env.CAREER_OPS_USER_ROOT)
  : process.cwd();

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

/** Classify a location string as 'CA' | 'US' | null (unknown/other). Exported. */
export function detectCountry(location) {
  const loc = String(location || '');
  if (!loc.trim()) return null;
  const low = loc.toLowerCase();
  if (CA_RE.test(low)) return 'CA';
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
 * rank: 0 = remote (top), 1 = Canada on-site/hybrid, 2 = unknown location.
 * @returns {{ keep: boolean, reason: string, rank: number }}
 */
export function classifyRow({ title, location }) {
  const remote = REMOTE_RE.test(String(location || '')) || REMOTE_RE.test(String(title || ''));
  const country = detectCountry(location);
  // Remote (Canada-remote, US-remote, or region/worldwide-remote) is top priority.
  if (remote) return { keep: true, reason: 'Remote', rank: 0 };
  if (country === 'CA') return { keep: true, reason: 'Canada (on-site/hybrid)', rank: 1 };
  if (country === 'US') return { keep: false, reason: 'US on-site (excluded)', rank: 9 };
  if (!String(location || '').trim()) return { keep: true, reason: 'Location unknown', rank: 2 };
  return { keep: false, reason: 'Outside North America', rank: 9 };
}

/** Parse a pipeline `- [ ] url | company | title | location | posted: date` row. */
export function parsePipelineRow(line) {
  const m = line.match(/^- \[ \]\s*(.+)$/);
  if (!m) return null;
  const parts = m[1].split('|').map((s) => s.trim());
  return { url: parts[0] || '', company: parts[1] || '', title: parts[2] || '', location: parts[3] || '' };
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
  let dropped = 0;
  for (const { line, row } of rows) {
    const c = classifyRow(row);
    reasons[c.reason] = (reasons[c.reason] || 0) + 1;
    if (c.keep) kept.push({ line, rank: c.rank }); else dropped += 1;
  }
  // Stable sort by rank → remote first, then Canada on-site/hybrid, then unknown.
  kept.sort((a, b) => a.rank - b.rank);

  // Trim trailing blank header lines, then re-emit header + sorted kept rows.
  while (header.length && header[header.length - 1].trim() === '') header.pop();
  const out = `${header.join('\n')}\n\n${kept.map((k) => k.line).join('\n')}\n`;
  writeFileSync(pipelinePath, out);

  if (asJson) {
    console.log(JSON.stringify({ kept: kept.length, dropped, reasons }));
  } else {
    console.log(`🌎 Geo-policy: kept ${kept.length} (remote first), dropped ${dropped}`);
    for (const [r, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
      console.log(`   ${n.toString().padStart(4)} · ${r}`);
    }
  }
}
