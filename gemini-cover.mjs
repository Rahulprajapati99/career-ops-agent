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
 * JSON reliability: the model call is pinned with a responseSchema
 * (constrained decoding), the reply goes through a fence-stripping balanced
 * parser, and the call retries once — free-tier flash models occasionally
 * emit unescaped quotes without these guards (seen live 2026-07-23).
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
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const USER_ROOT = process.env.CAREER_OPS_USER_ROOT
  ? resolve(process.env.CAREER_OPS_USER_ROOT)
  : process.cwd();

/**
 * Parse a model reply that should be one JSON object: strips code fences,
 * trims to the outermost balanced braces, then JSON.parse. Exported for tests.
 * @param {string} text
 */
export function parseModelJson(text) {
  let t = String(text || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in model reply');
  return JSON.parse(t.slice(start, end + 1));
}

/** Constrained-decoding schema for the letter payload. */
export const LETTER_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    company: { type: SchemaType.STRING },
    role_title: { type: SchemaType.STRING },
    greeting: { type: SchemaType.STRING },
    opening: { type: SchemaType.STRING },
    profile_intro: { type: SchemaType.STRING },
    achievements: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          lead: { type: SchemaType.STRING },
          impact: { type: SchemaType.STRING },
        },
        required: ['lead', 'impact'],
      },
    },
    closing: { type: SchemaType.STRING },
  },
  required: ['company', 'role_title', 'opening', 'profile_intro', 'closing'],
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
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

  // --- load context (all user-layer reads resolve under USER_ROOT) ----------
  const readIfExists = (p) => (existsSync(p) ? readFileSync(p, 'utf-8') : '');
  const report = readFileSync(resolve(USER_ROOT, reportPath), 'utf-8');
  const jd = jdPath ? readIfExists(resolve(USER_ROOT, jdPath)) : '';
  const cv = readIfExists(join(USER_ROOT, 'cv.md'));
  const profilePath = process.env.CAREER_OPS_PROFILE || join(USER_ROOT, 'config', 'profile.yml');
  let profile = {};
  try {
    profile = yaml.load(readIfExists(profilePath)) || {};
  } catch { /* malformed profile → defaults below */ }
  const cand = profile.candidate || {};

  // --- ask Gemini for the letter body (schema-constrained JSON) -------------
  const modelName = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: LETTER_SCHEMA,
      temperature: 0.4,
    },
  });

  const prompt = `You are a career assistant writing a one-page cover letter.

STRICT RULES:
- Use ONLY facts present in the CV and evaluation report below. Never invent employers, metrics, tools, or claims.
- No corporate-speak. Banned: "passionate about", "perfect fit", "unique opportunity".
- Concise: opening 1-2 sentences; profile_intro 2-3 sentences; 2-3 achievements; closing 1-2 sentences.
- Match the report's language (default English).
- Do not use double-quote characters inside field values; prefer plain wording.

Fill the JSON schema with: company, role_title, greeting (e.g. Dear Hiring Team,), opening (why this role, specific), profile_intro (who the candidate is, grounded in the CV), achievements (2-3 items, each lead + one-sentence quantified impact from the CV), closing (low-key call to action).

=== EVALUATION REPORT ===
${report.slice(0, 14000)}

${jd ? `=== JOB DESCRIPTION ===\n${jd.slice(0, 8000)}\n` : ''}
=== CV ===
${cv.slice(0, 14000)}
`;

  console.log(`🤖 Generating cover letter with ${modelName}...`);
  let letter = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= 2 && !letter; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      letter = parseModelJson(result.response.text());
    } catch (err) {
      lastErr = err;
      console.error(`⚠️ Attempt ${attempt} failed (${err.message})${attempt < 2 ? ' — retrying' : ''}`);
    }
  }
  if (!letter) {
    console.error(`❌ Gemini returned an unusable payload after 2 attempts: ${lastErr?.message}`);
    process.exit(1);
  }
  for (const key of ['company', 'role_title', 'opening', 'profile_intro', 'closing']) {
    if (!letter[key] || typeof letter[key] !== 'string') {
      console.error(`❌ Generated letter is missing "${key}"`);
      process.exit(1);
    }
  }

  // --- assemble the generate-cover-letter.mjs payload -----------------------
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

  // --- render via the existing generator (system script, repo-rooted) -------
  execFileSync(process.execPath, [join(__dirname, 'generate-cover-letter.mjs'), '--payload', payloadPath], {
    cwd: USER_ROOT,
    stdio: 'inherit',
  });

  console.log(`COVER_PDF_PATH: ${payload.output_path}`);
}
