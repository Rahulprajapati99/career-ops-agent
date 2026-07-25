#!/usr/bin/env node

/**
 * derive-prefs.mjs — build a job-scan profile from a person's OWN résumé.
 *
 * Why this exists: the named presets in templates/role-presets.yml describe the
 * two family members who were onboarded by hand. A new member can come from any
 * background — nursing, accounting, warehouse ops — and offering them somebody
 * else's role list would aim their scan at jobs they cannot do. So a new user's
 * search is derived from their resume instead: the job titles they have actually
 * held, the skills the CV evidences, and their seniority.
 *
 * Zero tokens, no network. Deterministic, so the same CV always yields the same
 * search and the result can be explained back to the user.
 *
 * Output is deliberately PRESET-SHAPED ({ label, titles, filter, search_any,
 * google_query, yc_roles }) so job-prefs.mjs can apply it through the exact same
 * code path as a named preset — one writer, one set of guarantees.
 *
 * Usage:
 *   node derive-prefs.mjs                    # describe what it finds (from cv.md)
 *   node derive-prefs.mjs --json             # machine-readable
 *   node derive-prefs.mjs --cv path/to.md    # a specific CV file
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SKILL_HINTS } from './ats-match.mjs';

const USER_ROOT = process.env.CAREER_OPS_USER_ROOT
  ? resolve(process.env.CAREER_OPS_USER_ROOT)
  : process.cwd();

/**
 * Nouns that end a real job title. A line only counts as a title when it
 * contains one of these, which is what separates "Senior QA Engineer" from a
 * bullet like "Improved release throughput by 40%".
 */
const ROLE_NOUNS = [
  'engineer', 'developer', 'architect', 'analyst', 'scientist', 'administrator',
  'manager', 'director', 'lead', 'supervisor', 'coordinator', 'specialist',
  'consultant', 'advisor', 'partner', 'generalist', 'recruiter', 'designer',
  'technician', 'accountant', 'auditor', 'bookkeeper', 'controller',
  'nurse', 'therapist', 'pharmacist', 'technologist', 'assistant',
  'representative', 'agent', 'associate', 'officer', 'clerk', 'planner',
  'buyer', 'estimator', 'inspector', 'operator', 'foreman', 'electrician',
  'mechanic', 'machinist', 'welder', 'driver', 'chef', 'teacher', 'instructor',
  'professor', 'trainer', 'writer', 'editor', 'marketer', 'strategist',
  'paralegal', 'attorney', 'sdet', 'tester', 'programmer',
];

const SENIORITY = ['principal', 'staff', 'senior', 'sr', 'lead', 'head', 'chief', 'junior', 'jr', 'intermediate'];

/** Kept upper-case when a derived title is rendered — "QA Analyst", not "Qa Analyst". */
const ACRONYMS = new Set(['qa', 'hr', 'ai', 'ml', 'it', 'ux', 'ui', 'sdet', 'sql', 'aws', 'gcp',
  'api', 'erp', 'crm', 'seo', 'sre', 'qc', 'ehs', 'cnc', 'hvac', 'cad', 'llm', 'bi', 'pmo', 'cpa']);

// Words that appear in title-like lines but carry no matching signal.
const NOISE = new Set([
  'the', 'and', 'or', 'of', 'in', 'at', 'for', 'to', 'with', 'a', 'an', 'on',
  'company', 'inc', 'ltd', 'llc', 'corp', 'corporation', 'limited', 'canada',
  'present', 'current', 'remote', 'hybrid', 'onsite', 'contract', 'fulltime',
  'full', 'time', 'part', 'permanent', 'intern', 'internship', 'co', 'op',
  'experience', 'work', 'employment', 'history', 'summary', 'profile',
  'responsibilities', 'achievements', 'education', 'skills', 'projects',
]);

/** Strip a résumé line down to the title part, dropping company/date decoration. */
function titleCandidate(line) {
  let s = String(line || '')
    .replace(/^[\s#*\->•·|]+/, '')            // markdown/bullet decoration
    .replace(/\(.*?\)/g, ' ')                  // (2021 - 2024)
    .replace(/\b\d{4}\b.*$/, ' ')              // trailing date ranges
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b.*$/i, ' ')
    .trim();
  // "Senior QA Engineer — Acme Corp" / "Senior QA Engineer, Acme" → keep the role.
  s = s.split(/\s+[—–|@]\s+|\s+\bat\b\s+/i)[0];
  s = s.split(',')[0];
  return s.replace(/[^A-Za-z0-9+#/&\s-]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Significant lowercase words of a string. */
function words(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9+#/]+/g, ' ').split(' ')
    .filter((w) => w && !NOISE.has(w));
}

/**
 * Job titles the résumé shows this person has held, most frequent first.
 *
 * A line qualifies when it is short enough to be a heading, contains a role
 * noun, and is not prose (no sentence-ending punctuation, few filler words).
 * Frequency ordering matters: the role someone held three times is a better
 * search target than a one-off.
 *
 * @param {string} cvText
 * @param {number} [limit=12]
 * @returns {string[]}
 */
export function extractTitles(cvText, limit = 12) {
  const counts = new Map();
  for (const rawLine of String(cvText || '').split('\n')) {
    if (rawLine.length > 120) continue;                 // prose, not a heading
    if (/[.!?]\s*$/.test(rawLine.trim())) continue;     // full sentence
    const cand = titleCandidate(rawLine);
    if (!cand || cand.length < 3 || cand.length > 60) continue;
    const w = words(cand);
    if (w.length === 0 || w.length > 6) continue;
    if (!w.some((x) => ROLE_NOUNS.includes(x))) continue;
    // Title Case it so the value reads like a title wherever it is shown,
    // keeping industry acronyms upper-cased ("QA", not "Qa").
    const title = w.map((x) => (ACRONYMS.has(x) ? x.toUpperCase() : x[0].toUpperCase() + x.slice(1))).join(' ');
    counts.set(title, (counts.get(title) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([t]) => t);
}

/**
 * Shortest distinctive filter terms for a set of titles.
 *
 * The filter is a SUBSTRING test applied to postings, so it must be broader than
 * the titles themselves: seniority prefixes are stripped (a "Senior QA Engineer"
 * should still see "QA Engineer" postings, with ranking left to priority_titles)
 * and each title contributes its role-noun phrase.
 *
 * @param {string[]} titles
 * @returns {string[]}
 */
export function deriveFilter(titles) {
  const terms = new Set();
  for (const t of titles) {
    const w = words(t).filter((x) => !SENIORITY.includes(x));
    if (w.length === 0) continue;
    const nounAt = w.findIndex((x) => ROLE_NOUNS.includes(x));
    if (nounAt === -1) continue;
    // The role noun plus up to two qualifying words before it: "quality
    // assurance analyst" from "Senior Quality Assurance Analyst".
    const phrase = w.slice(Math.max(0, nounAt - 2), nounAt + 1).join(' ');
    if (phrase.length >= 3) terms.add(phrase);
    // Also the tighter two-word form, which catches reworded postings.
    if (nounAt >= 1) terms.add(w.slice(nounAt - 1, nounAt + 1).join(' '));
  }
  return [...terms].sort((a, b) => a.length - b.length).slice(0, 12);
}

/** Skills the CV evidences, from the shared ATS vocabulary. */
export function extractSkills(cvText, limit = 12) {
  const hay = ` ${String(cvText || '').toLowerCase().replace(/[^a-z0-9+#./-]+/g, ' ')} `;
  return SKILL_HINTS.filter((s) => hay.includes(` ${s} `) || hay.includes(` ${s}s `)).slice(0, limit);
}

/** Highest seniority word in the CV's opening (headline/summary), or ''. */
export function extractSeniority(cvText) {
  const head = ` ${String(cvText || '').slice(0, 1200).toLowerCase()} `;
  return SENIORITY.find((s) => head.includes(` ${s} `)) || '';
}

/**
 * Build a preset-shaped scan profile from a résumé.
 *
 * @param {string} cvText
 * @returns {{label: string, titles: string[], filter: string[], search_any: string,
 *            google_query: string, yc_roles: string[], skills: string[],
 *            seniority: string, derived: true, confident: boolean}}
 */
export function derivePrefsFromCv(cvText) {
  const titles = extractTitles(cvText);
  const skills = extractSkills(cvText);
  const seniority = extractSeniority(cvText);
  const filter = deriveFilter(titles);

  // Google Jobs wants a handful of OR'd phrases; more than that returns noise.
  const google = titles.slice(0, 5).map((t) => `"${t}"`).join(' OR ');
  // Adzuna what_or matches ANY word: role nouns + the strongest skills.
  const searchWords = [...new Set([
    ...filter.slice(0, 4).flatMap((f) => f.split(' ')),
    ...skills.slice(0, 4).flatMap((s) => s.split(/\s+/)),
  ])].filter((w) => w.length > 1).slice(0, 10);

  const primary = titles[0] || '';
  return {
    label: primary ? `From your resume — ${primary}` : 'From your resume',
    titles,
    filter,
    search_any: searchWords.join(' '),
    google_query: google || primary,
    // Keep YC broad: a derived profile has no reliable category signal.
    yc_roles: ['eng', 'product', 'operations'],
    skills,
    seniority,
    derived: true,
    // Enough signal to aim a scan? Below this the caller should ask the user
    // rather than silently configuring a bad search.
    confident: titles.length >= 2 && filter.length >= 1,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--cv');
  const cvPath = at !== -1 && args[at + 1] ? resolve(args[at + 1]) : join(USER_ROOT, 'cv.md');
  if (!existsSync(cvPath)) {
    console.error(`❌ no résumé at ${cvPath} — upload one first.`);
    process.exit(1);
  }
  const prefs = derivePrefsFromCv(readFileSync(cvPath, 'utf-8'));
  if (args.includes('--json')) {
    console.log(JSON.stringify(prefs, null, 2));
  } else {
    console.log(`📄 Derived from ${cvPath}\n`);
    console.log(`  confident : ${prefs.confident ? 'yes' : 'no — too little signal, ask the user'}`);
    console.log(`  seniority : ${prefs.seniority || '(not stated)'}`);
    console.log(`  titles    : ${prefs.titles.join(' · ') || '(none found)'}`);
    console.log(`  filter    : ${prefs.filter.join(' · ') || '(none)'}`);
    console.log(`  skills    : ${prefs.skills.join(', ') || '(none)'}`);
    console.log(`  adzuna    : ${prefs.search_any}`);
    console.log(`  google    : ${prefs.google_query}`);
  }
}
