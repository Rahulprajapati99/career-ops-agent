#!/usr/bin/env node

/**
 * gemini-cover.mjs — Family Edition: generate a cover-letter payload with
 * Gemini and render it to PDF via generate-cover-letter.mjs.
 *
 * Bridges the gap between an evaluation report and the JSON payload that
 * generate-cover-letter.mjs expects ({ candidate, letter, output_path }).
 * Grounded in cv.md + config/profile.yml + the report — same non-fabrication
 * rule as the rest of career-ops: reformulate real experience, never invent.
 *
 * Usage:
 *   node gemini-cover.mjs --report reports/NNN-company.md [--jd jd.txt] [--out output/x-cover.pdf]
 *
 * Env: GEMINI_API_KEY (required), GEMINI_MODEL (default gemini-3.5-flash),
 *      CAREER_OPS_USER_ROOT / CAREER_OPS_PROFILE honored for multi-user setups.
 *
 * Output marker (for the Telegram bot / web dashboard):
 *   COVER_PDF_PATH: <path>
 */

import 'dotenv/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const USER_ROOT = process.env.CAREER_OPS_USER_ROOT
  ? resolve(process.env.CAREER_OPS_USER_ROOT)
  : process.cwd();

// --- args -------------------------------------------------------------------
const args = process.argv.slice(2);
let reportPath = null;
let jdPath = null;
let outPath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--report' && args[i + 1]) reportPath = args[++i];
  else if (args[i] === '--jd' && args[i + 1]) jdPath = args[++i];
  else if (args[i] === '--out' && args[i + 1]) outPath = args[++i];
}
if (!reportPath) {
  console.error('Usage: node gemini-cover.mjs --report <report.md> [--jd <jd.txt>] [--out <cover.pdf>]');
  process.exit(2);
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('❌ GEMINI_API_KEY not found — add it to .env');
  process.exit(1);
}

// --- load context (all user-layer reads resolve under USER_ROOT) ------------
function readIfExists(p) {
  return existsSync(p) ? readFileSync(p, 'utf-8') : '';
}
const report = readFileSync(resolve(USER_ROOT, reportPath), 'utf-8');
const jd = jdPath ? readIfExists(resolve(USER_ROOT, jdPath)) : '';
const cv = readIfExists(join(USER_ROOT, 'cv.md'));
const profilePath = process.env.CAREER_OPS_PROFILE || join(USER_ROOT, 'config', 'profile.yml');
let profile = {};
try {
  profile = yaml.load(readIfExists(profilePath)) || {};
} catch { /* malformed profile → defaults below */ }
const cand = profile.candidate || {};

// --- ask Gemini for the letter body (strict JSON) ---------------------------
const modelName = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({
  model: modelName,
  generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
});

const prompt = `You are a career assistant writing a one-page cover letter.

STRICT RULES:
- Use ONLY facts present in the CV and evaluation report below. Never invent employers, metrics, tools, or claims.
- No corporate-speak. Banned: "passionate about", "perfect fit", "unique opportunity".
- Concise: opening 1-2 sentences; profile_intro 2-3 sentences; 2-3 achievements; closing 1-2 sentences.
- Match the report's language (default English).

Return ONLY a JSON object with this exact shape:
{
  "company": "<company name>",
  "role_title": "<role title>",
  "greeting": "<e.g. Dear Hiring Team,>",
  "opening": "<why this role, specific>",
  "profile_intro": "<who the candidate is, grounded in the CV>",
  "achievements": [ { "lead": "<short bold lead>", "impact": "<one-sentence quantified impact from the CV>" } ],
  "closing": "<call to action, low-key>"
}

=== EVALUATION REPORT ===
${report.slice(0, 14000)}

${jd ? `=== JOB DESCRIPTION ===\n${jd.slice(0, 8000)}\n` : ''}
=== CV ===
${cv.slice(0, 14000)}
`;

console.log(`🤖 Generating cover letter with ${modelName}...`);
const result = await model.generateContent(prompt);
let letter;
try {
  letter = JSON.parse(result.response.text());
} catch (err) {
  console.error(`❌ Gemini returned non-JSON payload: ${err.message}`);
  process.exit(1);
}
for (const key of ['company', 'role_title', 'opening', 'profile_intro', 'closing']) {
  if (!letter[key] || typeof letter[key] !== 'string') {
    console.error(`❌ Generated letter is missing "${key}"`);
    process.exit(1);
  }
}

// --- assemble the generate-cover-letter.mjs payload -------------------------
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const defaultOut = join(USER_ROOT, 'output', `${slug(letter.company)}-${slug(letter.role_title)}-cover.pdf`);
const payload = {
  candidate: {
    name: cand.full_name || cand.name || 'Candidate',
    email: cand.email || '',
    phone: cand.phone || '',
    location: cand.location || '',
    linkedin: cand.linkedin || '',
  },
  letter: {
    company: letter.company,
    role_title: letter.role_title,
    date: new Date().toISOString().slice(0, 10),
    greeting: letter.greeting || 'Dear Hiring Team,',
    opening: letter.opening,
    profile_intro: letter.profile_intro,
    achievements: Array.isArray(letter.achievements) ? letter.achievements.slice(0, 3) : [],
    closing: letter.closing,
  },
  output_path: outPath ? resolve(USER_ROOT, outPath) : defaultOut,
};

mkdirSync(join(USER_ROOT, 'output'), { recursive: true });
const payloadPath = join(USER_ROOT, 'output', `${slug(letter.company)}-cover-payload.json`);
writeFileSync(payloadPath, JSON.stringify(payload, null, 2));

// --- render via the existing generator (system script, repo-rooted) ---------
execFileSync(process.execPath, [join(__dirname, 'generate-cover-letter.mjs'), '--payload', payloadPath], {
  cwd: USER_ROOT,
  stdio: 'inherit',
});

console.log(`COVER_PDF_PATH: ${payload.output_path}`);
