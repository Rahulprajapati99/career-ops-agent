#!/usr/bin/env node

/**
 * ats-match.mjs — Family Edition Phase 4: deterministic ATS match scoring.
 *
 * Compares a job description against a CV (and optionally the tailored HTML)
 * and reports keyword coverage the way ATS screeners see it: which of the
 * JD's highest-signal terms appear in the resume, which must-haves are
 * missing, and how the tailored version improved on the original.
 *
 * Zero-token by design — pure term extraction + weighting, no LLM call — so
 * it is free, instant, and reproducible. The tailor step consumes the missing
 * list; verify-cv-facts.mjs remains the guard against fabricating skills.
 *
 * Usage:
 *   node ats-match.mjs --jd <jd.txt> [--cv <cv.md>] [--html <tailored.html>] [--json]
 *
 * Defaults: --cv resolves to $CAREER_OPS_USER_ROOT/cv.md (or ./cv.md).
 *
 * Output markers (consumed by the Telegram bot / web dashboard):
 *   ATS_BEFORE: <0-100>
 *   ATS_AFTER: <0-100>          (only when --html is given)
 *   ATS_MISSING: term; term     (top must-haves still absent after tailoring,
 *                                or absent from the CV when no --html)
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const USER_ROOT = process.env.CAREER_OPS_USER_ROOT
  ? resolve(process.env.CAREER_OPS_USER_ROOT)
  : process.cwd();

// ---------------------------------------------------------------------------
// Curated skill hints — multi-word terms matched directly; boosts precision on
// the terms recruiters and ATS filters actually key on.
// ---------------------------------------------------------------------------
export const SKILL_HINTS = [
  // Languages & runtimes
  'python', 'javascript', 'typescript', 'java', 'golang', 'rust', 'ruby', 'php', 'scala',
  'kotlin', 'swift', 'c++', 'c#', 'sql', 'nosql', 'html', 'css', 'bash', 'powershell', 'r',
  // Frameworks & libs
  'react', 'angular', 'vue', 'next.js', 'node.js', 'django', 'flask', 'fastapi', 'spring',
  'rails', '.net', 'express', 'graphql', 'rest api', 'grpc', 'pytorch', 'tensorflow',
  'scikit-learn', 'pandas', 'spark', 'hadoop', 'kafka', 'airflow', 'dbt',
  // Cloud & infra
  'aws', 'azure', 'gcp', 'google cloud', 'kubernetes', 'docker', 'terraform', 'ansible',
  'jenkins', 'ci/cd', 'github actions', 'gitlab', 'serverless', 'lambda', 'cloudformation',
  'linux', 'devops', 'sre', 'observability', 'prometheus', 'grafana', 'datadog', 'splunk',
  // Data & ML
  'machine learning', 'deep learning', 'data science', 'data engineering', 'data analysis',
  'data pipeline', 'etl', 'nlp', 'computer vision', 'llm', 'generative ai', 'mlops',
  'a/b testing', 'statistics', 'big data', 'data warehouse', 'snowflake', 'databricks',
  'bigquery', 'redshift', 'tableau', 'power bi', 'looker', 'excel',
  // Databases
  'postgresql', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'dynamodb', 'oracle', 'cassandra',
  // QA & test automation — the tools QA job ads and ATS filters key on. Their
  // absence made every QA posting look like a zero-skill match, and the tailor
  // never flagged a missing "selenium"/"playwright" as an ATS keyword gap.
  'selenium', 'playwright', 'cypress', 'appium', 'webdriver', 'puppeteer', 'testng',
  'junit', 'pytest', 'jest', 'mocha', 'cucumber', 'bdd', 'robot framework', 'postman',
  'rest assured', 'soapui', 'jmeter', 'gatling', 'locust', 'load testing', 'performance testing',
  'regression testing', 'smoke testing', 'exploratory testing', 'manual testing',
  'test automation', 'test strategy', 'test plan', 'test case', 'test framework',
  'api testing', 'ui testing', 'mobile testing', 'accessibility testing', 'security testing',
  'sdet', 'qa automation', 'quality engineering', 'defect management', 'bug tracking',
  'testrail', 'zephyr', 'xray', 'shift-left', 'test coverage', 'sast', 'dast',
  // Practice & process
  'agile', 'scrum', 'kanban', 'jira', 'confluence', 'git', 'code review', 'unit testing',
  'integration testing', 'tdd', 'microservices', 'distributed systems', 'system design',
  'api design', 'security', 'oauth', 'authentication', 'performance optimization',
  // Business / PM / ops
  'project management', 'product management', 'stakeholder management', 'roadmap',
  'go-to-market', 'okrs', 'kpis', 'budgeting', 'forecasting', 'salesforce', 'crm', 'sap',
  'supply chain', 'procurement', 'six sigma', 'lean', 'quality assurance', 'compliance',
  'risk management', 'financial analysis', 'accounting', 'auditing', 'customer success',
  'account management', 'business development', 'marketing automation', 'seo', 'sem',
  'content marketing', 'copywriting', 'ux design', 'ui design', 'figma', 'user research',
  'accessibility', 'design systems',
];

// Words that carry no ATS signal — general English + job-posting boilerplate.
const STOPWORDS = new Set(('a about above after again all also an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with you your yours yourself yourselves ' +
  'ability able across additional advantage applicant applicants application apply benefits bonus candidate candidates career company culture day days description duties eg email employee employees employer employment environment equal etc excellent experience experienced flexible full function great group help hire hiring ideal include includes including individual individuals job join like location looking member members mission month months new offer opportunity opportunities others part people per plus position preferred provide qualified range related required requirement requirements responsibilities responsibility role roles salary seeking similar skills strong success successful team teams time title today utilize week weeks within work working world year years').split(/\s+/));

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Lowercase + collapse whitespace; keep +, #, . and / inside tokens (c++, ci/cd). */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')      // strip HTML tags when fed the tailored HTML
    .replace(/&[a-z]+;/g, ' ')
    .replace(/[^a-z0-9+#./\s-]/g, ' ')
    // Keep intra-token dots (node.js, ci/cd URLs) but drop sentence punctuation:
    // a '.' not followed by an alphanumeric would otherwise glue to the previous
    // word ("...some Python.") and break word-boundary matching.
    .replace(/\.(?![a-z0-9])/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when `term` (uni- or multi-word) is present in normalized text. */
export function termPresent(term, normText) {
  const t = term.toLowerCase();
  if (t.includes(' ')) return normText.includes(t);
  // Word-ish boundary that tolerates the symbol chars we preserve (c++, c#, .net).
  return new RegExp(`(^|[^a-z0-9+#.])${escapeRe(t)}($|[^a-z0-9+#.])`).test(` ${normText} `);
}

/**
 * Extract the JD's weighted keyword list. Exported for tests.
 *
 * Weights: base = term frequency; +3 when the term is a curated skill hint;
 * +2 when it appears on a requirements-flavored line ("must", "required",
 * "qualifications", "proficient", ...). Multi-word hints are matched directly.
 *
 * @param {string} jdText
 * @param {number} [topN=25]
 * @returns {{ term: string, weight: number, mustHave: boolean }[]}
 */
export function extractJdKeywords(jdText, topN = 25) {
  const norm = normalize(jdText);
  const reqLines = String(jdText || '')
    .split('\n')
    .filter((l) => /require|must[- ]have|must be|qualif|proficien|expert|essential|minimum/i.test(l))
    .map(normalize)
    .join('\n');

  const weights = new Map(); // term → { weight, mustHave }
  const bump = (term, w, mustHave = false) => {
    const cur = weights.get(term) || { weight: 0, mustHave: false };
    cur.weight += w;
    cur.mustHave = cur.mustHave || mustHave;
    weights.set(term, cur);
  };

  // 1) Curated hints — precision anchors (multi-word matched directly).
  for (const hint of SKILL_HINTS) {
    if (termPresent(hint, norm)) {
      const inReq = reqLines && termPresent(hint, reqLines);
      bump(hint, 3 + (inReq ? 2 : 0), Boolean(inReq));
    }
  }

  // 2) Frequency terms — unigrams that repeat and aren't noise.
  const tokens = norm.split(' ').filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
  const freq = new Map();
  for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
  for (const [t, f] of freq) {
    if (f < 2) continue;                    // one-off words are noise
    if (weights.has(t)) { bump(t, Math.min(f, 5)); continue; }
    const inReq = reqLines && termPresent(t, reqLines);
    bump(t, Math.min(f, 5) + (inReq ? 2 : 0), Boolean(inReq));
  }

  return Array.from(weights, ([term, v]) => ({ term, weight: v.weight, mustHave: v.mustHave }))
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
    .slice(0, topN);
}

/**
 * Score a CV against extracted JD keywords. Exported for tests.
 * @returns {{ score: number, matched: string[], missing: string[], missingMustHave: string[] }}
 */
export function scoreCv(keywords, cvText) {
  const norm = normalize(cvText);
  let total = 0;
  let hit = 0;
  const matched = [];
  const missing = [];
  const missingMustHave = [];
  for (const k of keywords) {
    total += k.weight;
    if (termPresent(k.term, norm)) {
      hit += k.weight;
      matched.push(k.term);
    } else {
      missing.push(k.term);
      if (k.mustHave) missingMustHave.push(k.term);
    }
  }
  const score = total === 0 ? 0 : Math.round((hit / total) * 100);
  return { score, matched, missing, missingMustHave };
}

/** Basic ATS format-safety checks on tailored HTML. Exported for tests. */
export function checkHtmlFormat(html) {
  const issues = [];
  if (/<table\b/i.test(html)) issues.push('uses <table> layout (many ATS parsers scramble tables)');
  if (/<img\b/i.test(html)) issues.push('contains images (ATS parsers skip them)');
  if (!/<h[12]\b/i.test(html)) issues.push('no h1/h2 headings (section detection may fail)');
  if (/column-count\s*:\s*[2-9]|grid-template-columns\s*:\s*[^;]*\s[^;]*/i.test(html)) {
    issues.push('multi-column layout detected (reading order may scramble)');
  }
  return issues;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
import { pathToFileURL } from 'node:url';
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  let jdPath = null; let cvPath = null; let htmlPath = null; let asJson = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--jd' && args[i + 1]) jdPath = args[++i];
    else if (args[i] === '--cv' && args[i + 1]) cvPath = args[++i];
    else if (args[i] === '--html' && args[i + 1]) htmlPath = args[++i];
    else if (args[i] === '--json') asJson = true;
  }
  if (!jdPath || !existsSync(jdPath)) {
    console.error('Usage: node ats-match.mjs --jd <jd.txt> [--cv <cv.md>] [--html <tailored.html>] [--json]');
    process.exit(2);
  }
  cvPath = cvPath || join(USER_ROOT, 'cv.md');
  if (!existsSync(cvPath)) {
    console.error(`❌ CV not found: ${cvPath}`);
    process.exit(1);
  }

  const jd = readFileSync(jdPath, 'utf-8');
  const keywords = extractJdKeywords(jd);
  const before = scoreCv(keywords, readFileSync(cvPath, 'utf-8'));

  let after = null;
  let formatIssues = [];
  if (htmlPath && existsSync(htmlPath)) {
    const html = readFileSync(htmlPath, 'utf-8');
    after = scoreCv(keywords, html);
    formatIssues = checkHtmlFormat(html);
  }

  const finalMissing = (after || before);
  if (asJson) {
    console.log(JSON.stringify({
      before: before.score,
      after: after ? after.score : null,
      keywords,
      matched: finalMissing.matched,
      missing: finalMissing.missing,
      missingMustHave: finalMissing.missingMustHave,
      formatIssues,
    }, null, 2));
  } else {
    console.log(`\n📊 ATS keyword match (top ${keywords.length} JD terms)`);
    console.log(`   Original CV:  ${before.score}%`);
    if (after) console.log(`   Tailored CV:  ${after.score}%  (${after.score >= before.score ? '+' : ''}${after.score - before.score})`);
    const gap = finalMissing.missingMustHave.length ? finalMissing.missingMustHave : finalMissing.missing;
    if (gap.length) console.log(`   Still missing: ${gap.slice(0, 8).join(', ')}`);
    for (const issue of formatIssues) console.log(`   ⚠️ Format: ${issue}`);
  }

  console.log(`ATS_BEFORE: ${before.score}`);
  if (after) console.log(`ATS_AFTER: ${after.score}`);
  const missOut = (finalMissing.missingMustHave.length ? finalMissing.missingMustHave : finalMissing.missing).slice(0, 8);
  if (missOut.length) console.log(`ATS_MISSING: ${missOut.join('; ')}`);
}
