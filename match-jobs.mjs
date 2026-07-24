#!/usr/bin/env node

/**
 * match-jobs.mjs — Phase 6: rank a user's scanned pipeline against THEIR profile.
 *
 * Zero tokens, fully deterministic. The scan already decides which postings
 * exist and geo-policy decides which are reachable; this decides which ones are
 * worth the user's attention, and in what order — so the daily digest can lead
 * with the three jobs that actually fit instead of whatever scrolled in last.
 *
 * Signal (all local, all explainable):
 *   · title_filter.positive hits from the user's own portals.yml  — strongest
 *   · overlap between the title and the skills in the user's cv.md
 *   · geography rank from geo-policy (remote > Canada > unknown)
 *   · seniority agreement between the CV and the posting
 *   · title_filter.negative and data/blacklist.md → hard drop
 *
 * Every score carries the reasons that produced it, so a surprising ranking can
 * be explained without re-running anything.
 *
 * Usage:
 *   node match-jobs.mjs                  # human-readable ranking
 *   node match-jobs.mjs --json           # machine-readable (used by the digest)
 *   node match-jobs.mjs --top 10         # limit output
 *   node match-jobs.mjs --min-score 40   # only rows at/above this score
 *
 * Reads CAREER_OPS_USER_ROOT / CAREER_OPS_PORTALS like every other user-layer
 * script, so `run-as-user.mjs <id> match-jobs.mjs` isolates it per user.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { parsePipelineRow, classifyRow, indiaEnabled } from './geo-policy.mjs';
import { SKILL_HINTS } from './ats-match.mjs';

const USER_ROOT = process.env.CAREER_OPS_USER_ROOT
  ? resolve(process.env.CAREER_OPS_USER_ROOT)
  : process.cwd();

/** Words that carry no matching signal in a job title. */
const TITLE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'you', 'our', 'their', 'this', 'that', 'from',
  'job', 'role', 'position', 'opportunity', 'team', 'new', 'all', 'any',
  'remote', 'hybrid', 'onsite', 'on-site', 'full', 'time', 'part', 'contract',
]);

const SENIORITY = ['principal', 'staff', 'lead', 'senior', 'sr', 'mid', 'junior', 'jr', 'entry', 'intern'];

/** Lowercase + strip punctuation so terms match on word boundaries. */
function norm(text) {
  return ` ${String(text || '').toLowerCase().replace(/[^a-z0-9+#./-]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

/**
 * Whole-word presence test that tolerates multi-word terms.
 *
 * norm() pads both ends and collapses runs of whitespace, so bounding the term
 * with spaces is a true word-boundary check. It must stay that strict: a
 * substring test made the one-letter skill "r" match the "r " inside
 * "QA Engineer ", and every job then claimed R as a matching skill.
 */
function has(normText, term) {
  const t = String(term || '').toLowerCase().trim();
  if (!t) return false;
  return normText.includes(` ${t} `) || normText.includes(` ${t}s `);
}

/** Meaningful tokens of a title. */
export function titleTokens(title) {
  return norm(title).split(' ').filter((w) => w.length > 2 && !TITLE_STOPWORDS.has(w));
}

/**
 * Skills the CV actually evidences, drawn from the shared ATS vocabulary so the
 * digest and the tailoring step speak about the same skills.
 *
 * @param {string} cvText
 * @returns {string[]}
 */
export function cvSkills(cvText) {
  const n = norm(cvText);
  return SKILL_HINTS.filter((s) => has(n, s));
}

/** Highest seniority word present, or '' when the text states none. */
export function seniorityOf(text) {
  const n = norm(text);
  return SENIORITY.find((s) => has(n, s)) || '';
}

/**
 * Score one posting for one user.
 *
 * @param {{title: string, company: string, location: string}} row
 * @param {{positives: string[], negatives: string[], skills: string[], seniority: string, blacklist: string[]}} profile
 * @returns {{score: number, reasons: string[], drop: string|null}}
 */
export function scoreRow(row, profile) {
  const { positives = [], negatives = [], skills = [], seniority = '', blacklist = [] } = profile;
  const title = norm(row.title);
  const company = String(row.company || '').toLowerCase().trim();
  const reasons = [];

  // --- hard drops ----------------------------------------------------------
  const negHit = negatives.find((t) => has(title, t));
  if (negHit) return { score: 0, reasons: [], drop: `title excludes "${negHit}"` };
  if (blacklist.some((b) => b && company.includes(b))) {
    return { score: 0, reasons: [], drop: `company blacklisted (${row.company})` };
  }

  let score = 0;

  // --- the user's own target titles (strongest signal) ---------------------
  const posHits = positives.filter((t) => has(title, t));
  if (posHits.length) {
    // Diminishing returns: three matching terms is not three times as relevant.
    score += Math.min(45, 25 + (posHits.length - 1) * 10);
    reasons.push(`matches your targets: ${posHits.slice(0, 3).join(', ')}`);
  }

  // --- CV skills named in the title ----------------------------------------
  const skillHits = skills.filter((s) => has(title, s));
  if (skillHits.length) {
    score += Math.min(25, skillHits.length * 12);
    reasons.push(`your skills in the title: ${skillHits.slice(0, 3).join(', ')}`);
  }

  // --- geography (remote first, matching geo-policy's own ranking) ----------
  const geo = classifyRow({ title: row.title, location: row.location }, { includeIndia: profile.includeIndia });
  if (geo.keep) {
    const geoPoints = { 0: 20, 1: 12, 2: 4, 3: 8 }[geo.rank] ?? 4;
    score += geoPoints;
    reasons.push(geo.reason.startsWith('India') ? 'in India' : geo.rank === 0 ? 'remote' : geo.rank === 1 ? 'in Canada' : 'location unstated');
  } else {
    return { score: 0, reasons: [], drop: 'outside your geography policy' };
  }

  // --- seniority agreement --------------------------------------------------
  const rowSeniority = seniorityOf(row.title);
  if (seniority && rowSeniority) {
    const senior = new Set(['principal', 'staff', 'lead', 'senior', 'sr']);
    const junior = new Set(['junior', 'jr', 'entry', 'intern']);
    if (senior.has(seniority) && senior.has(rowSeniority)) {
      score += 10;
      reasons.push(`seniority fits (${rowSeniority})`);
    } else if (senior.has(seniority) && junior.has(rowSeniority)) {
      score -= 15;
      reasons.push(`below your level (${rowSeniority})`);
    }
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons, drop: null };
}

/**
 * Load everything scoring needs from one user's data root.
 *
 * @param {string} [userRoot=USER_ROOT]
 * @returns {{positives: string[], negatives: string[], skills: string[], seniority: string, blacklist: string[]}}
 */
export function loadProfile(userRoot = USER_ROOT) {
  const portalsPath = process.env.CAREER_OPS_PORTALS || join(userRoot, 'portals.yml');
  let portals = {};
  try {
    if (existsSync(portalsPath)) portals = yaml.load(readFileSync(portalsPath, 'utf-8')) || {};
  } catch { /* malformed portals → fall back to CV-only signal */ }

  const cvPath = join(userRoot, 'cv.md');
  const cvText = existsSync(cvPath) ? readFileSync(cvPath, 'utf-8') : '';

  const blacklistPath = join(userRoot, 'data', 'blacklist.md');
  const blacklist = existsSync(blacklistPath)
    ? readFileSync(blacklistPath, 'utf-8').split('\n')
      .map((l) => l.replace(/^[-*\s[\]x]+/i, '').trim().toLowerCase())
      .filter((l) => l && !l.startsWith('#'))
    : [];

  return {
    positives: portals.title_filter?.positive || [],
    negatives: portals.title_filter?.negative || [],
    skills: cvSkills(cvText),
    seniority: seniorityOf(cvText.slice(0, 1500)), // headline/summary, not the whole history
    blacklist,
    includeIndia: indiaEnabled(portalsPath),
  };
}

/**
 * Rank every pending row in the user's pipeline.
 *
 * @param {string} [userRoot=USER_ROOT]
 * @returns {{matches: object[], dropped: object[], total: number}}
 */
export function rankPipeline(userRoot = USER_ROOT) {
  const pipelinePath = join(userRoot, 'data', 'pipeline.md');
  if (!existsSync(pipelinePath)) return { matches: [], dropped: [], total: 0 };

  const profile = loadProfile(userRoot);
  const matches = [];
  const dropped = [];

  for (const line of readFileSync(pipelinePath, 'utf-8').split('\n')) {
    const row = parsePipelineRow(line);
    if (!row || !row.url) continue;
    const { score, reasons, drop } = scoreRow(row, profile);
    if (drop) dropped.push({ ...row, reason: drop });
    else matches.push({ ...row, score, reasons });
  }

  // Highest score first; ties broken by company name so the order is stable
  // across runs (an unstable digest looks like new jobs arrived when none did).
  matches.sort((a, b) => b.score - a.score || a.company.localeCompare(b.company));
  return { matches, dropped, total: matches.length + dropped.length };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name, dflt) => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] ? Number(args[i + 1]) : dflt;
  };
  const top = flag('--top', 0);
  const minScore = flag('--min-score', 0);

  const { matches, dropped, total } = rankPipeline();
  const shown = matches.filter((m) => m.score >= minScore).slice(0, top || undefined);

  if (args.includes('--json')) {
    console.log(JSON.stringify({ total, matched: matches.length, dropped: dropped.length, jobs: shown }, null, 2));
  } else if (shown.length === 0) {
    console.log(`No matching jobs (${total} scanned, ${dropped.length} filtered out). Run /scan first.`);
  } else {
    console.log(`🎯 ${shown.length} of ${total} scanned jobs match your profile:\n`);
    for (const [i, m] of shown.entries()) {
      console.log(`${String(i + 1).padStart(2)}. [${String(m.score).padStart(3)}] ${m.title} — ${m.company}`);
      console.log(`     ${m.location || 'location unstated'}${m.reasons.length ? ` · ${m.reasons.join(' · ')}` : ''}`);
      console.log(`     ${m.url}`);
    }
    console.log(`\n${dropped.length} filtered out.`);
  }
}
