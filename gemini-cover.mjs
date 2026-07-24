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
 * Env: GEMINI_API_KEY (required), GEMINI_MODEL (default gemini-3.6-flash),
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
import { createFallbackModel } from './lib/gemini-call.mjs';

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

/** Collapse all whitespace (incl. newlines) to single spaces, trim, hard-cap. */
export function collapseField(s, max = 800) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Detect a field that captured a whole letter / signature block instead of the
 * intended fragment — the failure that produced duplicated text and giant
 * whitespace gaps (the model dumped the entire letter into `greeting`).
 */
export function looksLikeFullLetter(s) {
  const t = String(s || '');
  return /\b(sincerely|best regards|kind regards|yours truly|warm regards)\b/i.test(t)
    || (t.match(/\n/g) || []).length > 4
    || t.length > 1400;
}

/** Constrained-decoding schema for the letter payload (greeting is built in code). */
export const LETTER_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    company: { type: SchemaType.STRING },
    role_title: { type: SchemaType.STRING },
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
  const modelName = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const genAI = new GoogleGenerativeAI(apiKey);
  // Fallback-aware handle: when the primary model's DAILY free-tier quota is
  // gone, this switches to a model with its own pool instead of failing the
  // whole cover letter. Same interface as getGenerativeModel().
  const model = createFallbackModel(genAI, {
    model: modelName,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: LETTER_SCHEMA,
      temperature: 0.4,
    },
  }, { apiKey });

  const prompt = `You are a career assistant writing a one-page cover letter.

STRICT RULES:
- Use ONLY facts present in the CV and evaluation report below. Never invent employers, metrics, tools, or claims.
- No corporate-speak. Banned: "passionate about", "perfect fit", "unique opportunity".
- Match the report's language (default English).
- Do NOT use double-quote characters inside field values; prefer plain wording.
- Each field is ONE short fragment, NOT a full letter. Do NOT write a salutation ("Dear ...") or any sign-off ("Sincerely", the name, contact details) in ANY field — those are added automatically. Never repeat the letter across fields. No line breaks inside a field.

Fill the JSON schema (each field short and single-purpose):
- opening: 1-2 sentences on why this role, specific to the company.
- profile_intro: 2-3 sentences on who the candidate is, grounded in the CV.
- achievements: EXACTLY 2-3 array items, each { lead: a few words; impact: one quantified sentence from the CV }. This is the ONLY place achievements belong.
- closing: 1-2 sentence low-key call to action.

=== EVALUATION REPORT ===
${report.slice(0, 14000)}

${jd ? `=== JOB DESCRIPTION ===\n${jd.slice(0, 8000)}\n` : ''}
=== CV ===
${cv.slice(0, 14000)}
`;

  console.log(`🤖 Generating cover letter with ${modelName}...`);

  // Sanitize a raw model reply into clean, single-purpose, length-capped fields
  // so no field can carry a full letter or a wall of blank lines into the PDF.
  const sanitize = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const achievements = (Array.isArray(raw.achievements) ? raw.achievements : [])
      .map((a) => ({ lead: collapseField(a?.lead, 100), impact: collapseField(a?.impact, 260) }))
      .filter((a) => a.lead || a.impact)
      .slice(0, 3);
    return {
      company: collapseField(raw.company, 80),
      role_title: collapseField(raw.role_title, 120),
      opening: collapseField(raw.opening, 600),
      profile_intro: collapseField(raw.profile_intro, 800),
      closing: collapseField(raw.closing, 500),
      achievements,
    };
  };

  // Accept when the core fragments exist, none swallowed the whole letter, and
  // at least two achievements landed in the array.
  const isAcceptable = (L, raw) => Boolean(
    L && L.opening && L.profile_intro && L.closing
    && !['opening', 'profile_intro', 'closing'].some((k) => looksLikeFullLetter(raw?.[k]))
    && L.achievements.length >= 2,
  );

  let letter = null;
  let best = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3 && !letter; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const raw = parseModelJson(result.response.text());
      const L = sanitize(raw);
      if (isAcceptable(L, raw)) { letter = L; break; }
      if (L && L.opening && L.profile_intro && L.closing) best = L; // usable fallback
      console.error(`⚠️ Attempt ${attempt}: below quality bar (achievements=${L?.achievements.length ?? 0})${attempt < 3 ? ' — retrying' : ''}`);
    } catch (err) {
      lastErr = err;
      console.error(`⚠️ Attempt ${attempt} failed (${err.message})${attempt < 3 ? ' — retrying' : ''}`);
    }
  }
  letter = letter || best;
  if (!letter) {
    console.error(`❌ Gemini returned an unusable cover-letter payload after 3 attempts: ${lastErr?.message || 'quality bar not met'}`);
    process.exit(1);
  }

  // --- assemble the generate-cover-letter.mjs payload -----------------------
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const company = letter.company || 'the company';
  const roleTitle = letter.role_title || 'the role';
  const defaultOut = join(USER_ROOT, 'output', `${slug(company)}-${slug(roleTitle)}-cover.pdf`);
  const payload = {
    candidate: {
      name: cand.full_name || cand.name || 'Candidate',
      email: cand.email || '',
      phone: cand.phone || '',
      location: cand.location || '',
      linkedin: cand.linkedin || '',
    },
    letter: {
      company,
      role_title: roleTitle,
      date: new Date().toISOString().slice(0, 10),
      // Greeting is built here, never by the model (it abused the field).
      greeting: `Dear ${company} Hiring Team,`,
      opening: letter.opening,
      profile_intro: letter.profile_intro,
      achievements: letter.achievements,
      closing: letter.closing,
    },
    output_path: outPath ? resolve(USER_ROOT, outPath) : defaultOut,
  };

  mkdirSync(join(USER_ROOT, 'output'), { recursive: true });
  const payloadPath = join(USER_ROOT, 'output', `${slug(company)}-cover-payload.json`);
  writeFileSync(payloadPath, JSON.stringify(payload, null, 2));

  // --- render via the existing generator (system script, repo-rooted) -------
  execFileSync(process.execPath, [join(__dirname, 'generate-cover-letter.mjs'), '--payload', payloadPath], {
    cwd: USER_ROOT,
    stdio: 'inherit',
  });

  console.log(`COVER_PDF_PATH: ${payload.output_path}`);
}
