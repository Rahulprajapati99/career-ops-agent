#!/usr/bin/env node

/**
 * gemini-email.mjs — Family Edition Phase 5: draft a short outreach email to a
 * recruiter / hiring manager, grounded in the CV + evaluation report.
 *
 * Draft ONLY — prints a subject + body for the human to review and send. Never
 * sends. Companion to find-contact-email.mjs (which supplies the address).
 *
 * Usage:
 *   node gemini-email.mjs --report reports/NNN.md [--to-name "Jane Smith"] [--jd jd.txt]
 *
 * Env: GEMINI_API_KEY, GEMINI_MODEL (default gemini-3.6-flash),
 *      CAREER_OPS_USER_ROOT / CAREER_OPS_PROFILE for multi-user.
 *
 * Output markers (for the Telegram bot / web dashboard):
 *   EMAIL_SUBJECT: <subject>
 *   EMAIL_BODY_START
 *   <body …>
 *   EMAIL_BODY_END
 */

import 'dotenv/config';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { parseModelJson, collapseField } from './gemini-cover.mjs';

const USER_ROOT = process.env.CAREER_OPS_USER_ROOT
  ? resolve(process.env.CAREER_OPS_USER_ROOT)
  : process.cwd();

const EMAIL_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    subject: { type: SchemaType.STRING },
    body: { type: SchemaType.STRING }, // 3-5 short sentences, no salutation/sign-off
  },
  required: ['subject', 'body'],
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const get = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
  const reportPath = get('--report');
  const jdPath = get('--jd');
  const toName = get('--to-name');
  if (!reportPath) {
    console.error('Usage: node gemini-email.mjs --report <report.md> [--to-name "Name"] [--jd <jd.txt>]');
    process.exit(2);
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('❌ GEMINI_API_KEY not found — add it to .env'); process.exit(1); }

  const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf-8') : '');
  const report = readFileSync(resolve(USER_ROOT, reportPath), 'utf-8');
  const jd = jdPath ? readIf(resolve(USER_ROOT, jdPath)) : '';
  const cv = readIf(join(USER_ROOT, 'cv.md'));
  const profilePath = process.env.CAREER_OPS_PROFILE || join(USER_ROOT, 'config', 'profile.yml');
  let profile = {};
  try { profile = yaml.load(readIf(profilePath)) || {}; } catch { /* defaults */ }
  const cand = profile.candidate || {};

  const modelName = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
    model: modelName,
    generationConfig: { responseMimeType: 'application/json', responseSchema: EMAIL_SCHEMA, temperature: 0.4 },
  });

  const prompt = `Write a SHORT cold outreach email from a job applicant to a recruiter or hiring manager.

RULES:
- Use ONLY facts in the CV and evaluation report. Never invent employers, metrics, or tools.
- subject: under 70 characters, specific to the role.
- body: 3-5 short sentences — one line on the role interest, one strong proof point from the CV, one low-key ask (a brief chat / to share the CV). NO salutation ("Dear/Hi …") and NO sign-off/signature — those are added automatically.
- No corporate-speak. Banned: "passionate about", "perfect fit", "reaching out to". No double quotes inside values. No line breaks inside a field.

=== EVALUATION REPORT ===
${report.slice(0, 12000)}
${jd ? `\n=== JOB DESCRIPTION ===\n${jd.slice(0, 6000)}\n` : ''}
=== CV ===
${cv.slice(0, 12000)}
`;

  let out = null;
  for (let attempt = 1; attempt <= 2 && !out; attempt++) {
    try {
      const res = await model.generateContent(prompt);
      const raw = parseModelJson(res.response.text());
      const subject = collapseField(raw.subject, 120);
      const body = collapseField(raw.body, 900);
      if (subject && body.length > 40) out = { subject, body };
    } catch (err) {
      if (attempt === 2) { console.error(`❌ Draft failed: ${err.message}`); process.exit(1); }
    }
  }
  if (!out) { console.error('❌ Could not produce a usable email draft.'); process.exit(1); }

  // Assemble greeting + body + signature deterministically.
  const first = toName ? String(toName).trim().split(/\s+/)[0] : '';
  const greeting = first ? `Hi ${first},` : 'Hello,';
  const sigLines = [
    cand.full_name || cand.name || '',
    cand.email || '',
    cand.phone || '',
    cand.linkedin || '',
    cand.github ? `GitHub: ${cand.github}` : '',
    cand.portfolio_url ? `Portfolio: ${cand.portfolio_url}` : '',
  ].filter(Boolean);
  const fullBody = `${greeting}\n\n${out.body}\n\nBest regards,\n${sigLines.join('\n')}`;

  console.log(`EMAIL_SUBJECT: ${out.subject}`);
  console.log('EMAIL_BODY_START');
  console.log(fullBody);
  console.log('EMAIL_BODY_END');
}
