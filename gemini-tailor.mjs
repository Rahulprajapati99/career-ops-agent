#!/usr/bin/env node
/**
 * gemini-tailor.mjs — Gemini-powered CV Tailoring for career-ops
 *
 * Reads the candidate's base CV, profile, evaluation report, and JD,
 * then uses Google Gemini to generate a tailored HTML CV.
 *
 * Usage:
 *   node gemini-tailor.mjs --jd ./temp_jd.txt --report reports/001-company-2026.md
 *   node gemini-tailor.mjs --model gemini-3.6-flash --jd jd.txt --report report.md
 *
 * Requires:
 *   GEMINI_API_KEY in .env (or environment variable)
 *
 * Output:
 *   Tailored HTML file at output/cv-<candidate>-<company>.html
 *   Machine-readable output block for automation:
 *     ---TAILOR_OUTPUT---
 *     HTML_PATH: <path>
 *     ---END_TAILOR_OUTPUT---
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Bootstrap: load .env before anything else
// ---------------------------------------------------------------------------
try {
  const { config } = await import('dotenv');
  config();
} catch {
  // dotenv is optional
}

import { GoogleGenerativeAI } from '@google/generative-ai';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const ROOT = dirname(fileURLToPath(import.meta.url));
// User layer honors CAREER_OPS_USER_ROOT (multi-user); system files stay ROOT.
const USER_ROOT = process.env.CAREER_OPS_USER_ROOT
  ? resolve(process.env.CAREER_OPS_USER_ROOT)
  : ROOT;

const PATHS = {
  shared:   join(ROOT, 'modes', '_shared.md'),
  pdf:      join(ROOT, 'modes', 'pdf.md'),
  cv:       join(USER_ROOT, 'cv.md'),
  profile:  join(USER_ROOT, 'config', 'profile.yml'),
  template: join(ROOT, 'templates', 'cv-template.html'),
  output:   join(USER_ROOT, 'output'),
};

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║           career-ops — Gemini CV Tailor (free-tier)             ║
╚══════════════════════════════════════════════════════════════════╝

  Tailor your CV for a specific job using Google Gemini.

  USAGE
    node gemini-tailor.mjs --jd <path> --report <path>
    node gemini-tailor.mjs --model gemini-3.6-flash --jd jd.txt --report report.md

  OPTIONS
    --jd <path>      Path to the Job Description text file (required)
    --report <path>  Path to the evaluation report .md file (required)
    --model <name>   Gemini model (default: gemini-3.6-flash)
    --help           Show this help

  SETUP
    1. Get a free API key at https://aistudio.google.com/apikey
    2. Add GEMINI_API_KEY=<your-key> to .env
    3. Run: npm install   (installs @google/generative-ai + dotenv)

  EXAMPLES
    node gemini-tailor.mjs --jd jds/openai-swe.txt --report reports/042-openai-2026-07-14.md
    node gemini-tailor.mjs --model gemini-3.6-flash --jd temp_jd.txt --report reports/latest.md
`);
  process.exit(0);
}

let jdPath = '';
let reportPath = '';
let modelName = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--jd' && args[i + 1]) {
    jdPath = args[++i];
  } else if (args[i] === '--report' && args[i + 1]) {
    reportPath = args[++i];
  } else if (args[i] === '--model' && args[i + 1]) {
    modelName = args[++i];
  }
}

if (!jdPath || !reportPath) {
  console.error('❌  Both --jd and --report are required. Run with --help for usage.');
  process.exit(1);
}

if (!existsSync(jdPath)) {
  console.error(`❌  JD file not found: ${jdPath}`);
  process.exit(1);
}

if (!existsSync(reportPath)) {
  console.error(`❌  Report file not found: ${reportPath}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Validate environment
// ---------------------------------------------------------------------------
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error(`
❌  GEMINI_API_KEY not found.

   1. Get a free key at https://aistudio.google.com/apikey
   2. Add it to .env:   GEMINI_API_KEY=your_key_here
`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------
function readFile(path, label) {
  if (!existsSync(path)) {
    console.warn(`⚠️   ${label} not found at: ${path}`);
    return `[${label} not found — skipping]`;
  }
  return readFileSync(path, 'utf-8').trim();
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown';
}

function extractCompanyFromReport(reportText) {
  // Try "# Evaluation: CompanyName — Role"
  const titleMatch = reportText.match(/^#\s*Evaluation:\s*(.+?)\s*[-—]/m);
  if (titleMatch) return titleMatch[1].trim();
  // Try COMPANY: field in summary
  const companyMatch = reportText.match(/COMPANY:\s*(.+)/i);
  if (companyMatch) return companyMatch[1].trim();
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Load context files
// ---------------------------------------------------------------------------
console.log('\n📂  Loading context files...');

const sharedContext  = readFile(PATHS.shared,   'modes/_shared.md');
const pdfMode        = readFile(PATHS.pdf,      'modes/pdf.md');
const cvContent      = readFile(PATHS.cv,       'cv.md');
const profileYml     = readFile(PATHS.profile,  'config/profile.yml');
const templateHtml   = readFile(PATHS.template, 'templates/cv-template.html');
const jdText         = readFileSync(jdPath, 'utf-8').trim();
const reportText     = readFileSync(reportPath, 'utf-8').trim();

// ---------------------------------------------------------------------------
// Build the system prompt (mirrors openai-tailor.mjs structure)
// ---------------------------------------------------------------------------
const systemPrompt = `You are career-ops, an AI-powered CV tailoring engine.
You read a candidate's base CV, profile, an evaluation report, and a Job Description.
Your job is to apply strict anti-fabrication tailoring rules to fill in an HTML template.

═══════════════════════════════════════════════════════
SYSTEM CONTEXT (_shared.md)
═══════════════════════════════════════════════════════
${sharedContext}

═══════════════════════════════════════════════════════
CV TAILORING MODE (pdf.md)
═══════════════════════════════════════════════════════
${pdfMode}

═══════════════════════════════════════════════════════
HTML CV TEMPLATE (cv-template.html)
═══════════════════════════════════════════════════════
${templateHtml}

═══════════════════════════════════════════════════════
CANDIDATE BASE CV (cv.md)
═══════════════════════════════════════════════════════
${cvContent}

═══════════════════════════════════════════════════════
CANDIDATE PROFILE & TARGETS (config/profile.yml)
═══════════════════════════════════════════════════════
${profileYml}

═══════════════════════════════════════════════════════
CRITICAL OPERATING RULES — STRICTLY ENFORCED
═══════════════════════════════════════════════════════

ANTI-FABRICATION (ZERO TOLERANCE):
1. NEVER invent skills, metrics, projects, certifications, or experience.
   Every fact in the output MUST trace back to cv.md or profile.yml.
2. NEVER add words like "Verified", "Certified", "Accredited" to certifications
   unless those EXACT words appear in cv.md. Copy certification titles verbatim.
3. NEVER invent project names or descriptions. Use ONLY the projects listed in cv.md.
4. NEVER fabricate metrics (percentages, dollar amounts, team sizes) that are not in cv.md.

CONTENT PRESERVATION (MANDATORY):
5. Include ALL work experience entries from cv.md. Do NOT remove any job.
6. Include ALL skills and competencies from cv.md. You may REORDER them
   (JD-relevant skills first) but do NOT delete any.
7. Include ALL certifications and education from cv.md. Copy them exactly.
8. Include ALL projects from cv.md. Do NOT remove any.
9. Portfolio URL (rahulprajapati99.vercel.app) MUST appear in the contact section.

TAILORING (WHAT YOU CAN DO):
10. REPHRASE bullet points using JD vocabulary — same facts, different words.
11. REORDER sections and bullets — strongest JD matches first (6-second clarity gate).
12. ADJUST the Executive Summary to emphasize JD-relevant strengths.
13. ADD relevant competency tags from the JD IF the candidate demonstrably has them
    based on their experience in cv.md.

OUTPUT FORMAT:
14. Replace ALL {{PLACEHOLDERS}} in the HTML Template exactly as instructed.
15. Output the complete, raw HTML document starting with <!DOCTYPE html>.
16. Do NOT wrap output in markdown code fences or backticks.
17. Do NOT add ANY text before or after the HTML.
18. You have NO tools — your ONLY output is the HTML document.
`;

// ---------------------------------------------------------------------------
// Retry helper with exponential backoff + model fallback
// ---------------------------------------------------------------------------
const FALLBACK_MODELS = [
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryDelay(errorMsg) {
  const match = String(errorMsg).match(/retry in ([0-9.]+)s/i);
  return match ? Math.ceil(parseFloat(match[1]) * 1000) : null;
}

function isQuotaExhausted(errorMsg) {
  return /limit:\s*0/i.test(errorMsg) && /free_tier/i.test(errorMsg);
}

async function callGeminiWithRetry(genAI, modelId, contents, maxRetries = 3) {
  const model = genAI.getGenerativeModel({
    model: modelId,
    generationConfig: {
      temperature: 0.2,       // low for deterministic CV output
      maxOutputTokens: 16384, // full HTML CV can be large
    },
  });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await model.generateContent(contents);
      return result.response.text();
    } catch (err) {
      const msg = String(err.message || '');
      const sanitizedMsg = msg.split(apiKey).join('[REDACTED]');

      // Non-retryable
      if (msg.includes('API_KEY') || msg.includes('PERMISSION_DENIED') || msg.includes('NOT_FOUND')) {
        throw new Error(`Gemini API error (non-retryable): ${sanitizedMsg}`);
      }

      // Daily quota exhausted — no point retrying this model
      if (isQuotaExhausted(msg)) {
        throw new Error(`QUOTA_EXHAUSTED: ${sanitizedMsg}`);
      }

      // Transient rate limit — retry with backoff
      if (msg.includes('429') || msg.includes('quota') || msg.includes('rate') || msg.includes('RESOURCE_EXHAUSTED')) {
        const serverDelay = parseRetryDelay(msg);
        const backoff = serverDelay || Math.min(2000 * Math.pow(2, attempt - 1), 30000);
        if (attempt < maxRetries) {
          console.warn(`⚠️   Rate limited on attempt ${attempt}/${maxRetries}. Retrying in ${(backoff / 1000).toFixed(1)}s...`);
          await sleep(backoff);
          continue;
        }
      }

      if (attempt === maxRetries) {
        throw new Error(`Gemini API error after ${maxRetries} attempts: ${sanitizedMsg}`);
      }

      const backoff = 2000 * Math.pow(2, attempt - 1);
      console.warn(`⚠️   Attempt ${attempt}/${maxRetries} failed. Retrying in ${(backoff / 1000).toFixed(1)}s...`);
      await sleep(backoff);
    }
  }
}

// ---------------------------------------------------------------------------
// Call Gemini API (with retry + fallback)
// ---------------------------------------------------------------------------
console.log(`🤖  Calling Gemini (${modelName}) for CV tailoring... this may take 30-90 seconds.\n`);

const genAI = new GoogleGenerativeAI(apiKey);
const contents = [
  { text: systemPrompt },
  {
    text: `\n\nEVALUATION REPORT:\n\n${reportText}\n\nJOB DESCRIPTION:\n\n${jdText}\n\nNow, generate and output the fully filled HTML CV matching the rules above. Output ONLY raw HTML.`,
  },
];

let tailoredHtml;
let usedModel = modelName;

try {
  tailoredHtml = await callGeminiWithRetry(genAI, modelName, contents);
} catch (primaryErr) {
  const isPrimaryQuotaExhausted = String(primaryErr.message).startsWith('QUOTA_EXHAUSTED');

  if (isPrimaryQuotaExhausted) {
    console.warn(`⚠️   ${modelName} daily quota exhausted. Trying fallback models...`);

    let fallbackSucceeded = false;
    for (const fallback of FALLBACK_MODELS) {
      if (fallback === modelName) continue;
      try {
        console.log(`🔄  Trying fallback model: ${fallback}...`);
        tailoredHtml = await callGeminiWithRetry(genAI, fallback, contents);
        usedModel = fallback;
        fallbackSucceeded = true;
        console.log(`✅  Fallback to ${fallback} succeeded.`);
        break;
      } catch (fbErr) {
        console.warn(`⚠️   Fallback ${fallback} also failed: ${String(fbErr.message).slice(0, 120)}`);
      }
    }

    if (!fallbackSucceeded) {
      console.error('\n❌  All models exhausted. Your free-tier daily quota is used up.');
      console.error('    Wait until tomorrow or upgrade to paid tier.\n');
      process.exit(1);
    }
  } else {
    console.error('❌  Gemini API error:', primaryErr.message);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Post-process: strip markdown code fences if model wrapped the output
// ---------------------------------------------------------------------------
tailoredHtml = tailoredHtml
  .replace(/^[\s\S]*?(<!DOCTYPE)/i, '$1')  // strip anything before <!DOCTYPE
  .replace(/```\s*$/i, '')                   // strip trailing code fence
  .trim();

// If no <!DOCTYPE found, try to salvage from <html>
if (!tailoredHtml.startsWith('<!DOCTYPE') && !tailoredHtml.startsWith('<html')) {
  const htmlStart = tailoredHtml.indexOf('<html');
  if (htmlStart >= 0) {
    tailoredHtml = tailoredHtml.slice(htmlStart);
  } else {
    console.error('❌  Gemini output does not look like valid HTML.');
    console.error('    First 300 chars:', tailoredHtml.slice(0, 300));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Extract names for filename
// ---------------------------------------------------------------------------
let candidateSlug = 'candidate';
try {
  const nameMatch = profileYml.match(/full_name:\s*"?([^"\n]+)"?/i);
  if (nameMatch) candidateSlug = slugify(nameMatch[1]);
} catch { /* use default */ }

const company     = extractCompanyFromReport(reportText);
const companySlug = slugify(company);

// ---------------------------------------------------------------------------
// Save tailored HTML
// ---------------------------------------------------------------------------
if (!existsSync(PATHS.output)) mkdirSync(PATHS.output, { recursive: true });

const htmlFilename = `cv-${candidateSlug}-${companySlug}.html`;
const htmlPath     = join(PATHS.output, htmlFilename);

writeFileSync(htmlPath, tailoredHtml, 'utf-8');

console.log(`\n✅  Tailored CV saved: output/${htmlFilename}`);
if (usedModel !== modelName) {
  console.warn(`⚠️   Generated by ${usedModel} (fallback), not ${modelName}.`);
}

// Machine-readable output for automation (e.g., telegram-bot.mjs)
console.log('\n---TAILOR_OUTPUT---');
console.log(`HTML_PATH: ${htmlPath}`);
console.log(`COMPANY: ${company}`);
console.log(`CANDIDATE: ${candidateSlug}`);
console.log('---END_TAILOR_OUTPUT---');

console.log(`\n📄  Next step — generate PDF:`);
console.log(`    node generate-pdf.mjs ${htmlPath} output/cv-${candidateSlug}-${companySlug}.pdf\n`);
