#!/usr/bin/env node

/**
 * cv-import.mjs — Family Edition: import an uploaded resume into cv.md.
 *
 * Accepts .md / .txt (saved near-verbatim) or .pdf (transcribed to markdown
 * with Gemini's inline-document support). The original upload is preserved
 * under data/cv-uploads/ so nothing is lost if the transcription needs a
 * manual touch-up. DOCX is not supported — export to PDF or paste text.
 *
 * After a successful import the candidate basics (name, email, phone,
 * linkedin) found in the resume are synced into config/profile.yml — but only
 * over placeholder/example values, never over deliberate user edits. This is
 * what keeps generated filenames ("cv-<candidate>-<company>.pdf") and cover
 * letter contact blocks pointing at the real person instead of Jane Smith.
 *
 * Usage:
 *   node cv-import.mjs --file <uploaded-resume.(md|txt|pdf)>
 *   node cv-import.mjs --sync-profile        # re-sync profile from existing cv.md
 *
 * Env: CAREER_OPS_USER_ROOT (target user root; default cwd),
 *      CAREER_OPS_PROFILE (profile path override),
 *      GEMINI_API_KEY + GEMINI_MODEL (PDF transcription only).
 *
 * Output marker (for the Telegram bot / web dashboard):
 *   CV_PATH: <path>
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const USER_ROOT = process.env.CAREER_OPS_USER_ROOT
  ? resolve(process.env.CAREER_OPS_USER_ROOT)
  : process.cwd();

// ---------------------------------------------------------------------------
// Candidate basics extraction + profile sync
// ---------------------------------------------------------------------------

/**
 * Pull candidate basics out of a markdown resume. Deterministic (no LLM):
 * name = first H1; email/phone/linkedin by pattern. Missing fields are
 * omitted rather than guessed. Exported for tests.
 * @param {string} markdown
 * @returns {{ full_name?: string, email?: string, phone?: string, linkedin?: string }}
 */
export function extractCandidateBasics(markdown) {
  const out = {};
  const text = String(markdown || '');

  const h1 = text.match(/^#\s+(.+)$/m);
  if (h1) {
    // Strip markdown emphasis and trailing taglines ("Rahul P. | QA Lead").
    let name = h1[1].replace(/[*_`]/g, '').split(/\s*[|—•]\s*/)[0].trim();
    // Resumes often shout the name in ALL CAPS — title-case it for documents.
    if (name && name === name.toUpperCase()) {
      name = name.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (c) => c.toUpperCase());
    }
    if (name && name.length <= 60) out.full_name = name;
  }

  const email = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  if (email) out.email = email[0];

  const linkedin = text.match(/linkedin\.com\/in\/[A-Za-z0-9\-_%.]+/i);
  if (linkedin) out.linkedin = linkedin[0].replace(/[.,;)]+$/, '');

  const phone = text.match(/(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/);
  if (phone) out.phone = phone[0].trim();

  return out;
}

/** Example values shipped in config/profile.example.yml — safe to overwrite. */
const PLACEHOLDERS = new Set([
  'jane smith', 'jane@example.com', '+1-555-0123',
  'linkedin.com/in/janesmith', 'san francisco, ca', '',
]);

/**
 * Sync extracted basics into profile.yml via targeted line edits (the file is
 * comment-heavy documentation — a YAML round-trip would destroy it). A key is
 * only rewritten when its current value is a known placeholder or empty, so
 * deliberate user edits always win. Exported for tests.
 * @returns {string[]} keys that were updated
 */
export function syncProfileFromCv(markdown, profilePath) {
  if (!existsSync(profilePath)) return [];
  const basics = extractCandidateBasics(markdown);
  let profile = readFileSync(profilePath, 'utf-8');
  const updated = [];

  for (const [key, value] of Object.entries(basics)) {
    const re = new RegExp(`^(\\s*)(${key}):\\s*"?([^"\\n#]*?)"?\\s*$`, 'm');
    const m = profile.match(re);
    if (!m) continue;
    if (!PLACEHOLDERS.has(m[3].trim().toLowerCase())) continue; // user-edited — keep
    profile = profile.replace(re, `$1$2: "${value.replace(/"/g, '')}"`);
    updated.push(key);
  }

  // Example values we can't extract a real replacement for get BLANKED so a
  // fake link/city never leaks into generated documents.
  const blankIfPlaceholder = {
    portfolio_url: 'https://janesmith.dev',
    location: 'san francisco, ca',
  };
  for (const [key, placeholder] of Object.entries(blankIfPlaceholder)) {
    const re = new RegExp(`^(\\s*)(${key}):\\s*"?([^"\\n#]*?)"?\\s*$`, 'm');
    const m = profile.match(re);
    if (m && m[3].trim().toLowerCase() === placeholder) {
      profile = profile.replace(re, `$1$2: ""`);
      updated.push(`${key} (cleared placeholder)`);
    }
  }

  if (updated.length) writeFileSync(profilePath, profile);
  return updated;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const profilePath = process.env.CAREER_OPS_PROFILE || join(USER_ROOT, 'config', 'profile.yml');
  const cvPath = join(USER_ROOT, 'cv.md');

  // --sync-profile: re-run just the profile sync from the existing cv.md.
  if (args.includes('--sync-profile')) {
    if (!existsSync(cvPath)) {
      console.error(`❌ No cv.md at ${cvPath} — import a resume first`);
      process.exit(1);
    }
    const updated = syncProfileFromCv(readFileSync(cvPath, 'utf-8'), profilePath);
    console.log(updated.length
      ? `✅ Profile synced from CV: ${updated.join(', ')}`
      : 'ℹ️ Profile unchanged (no placeholders left to fill).');
    process.exit(0);
  }

  let filePath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1]) filePath = args[++i];
  }
  if (!filePath || !existsSync(filePath)) {
    console.error('Usage: node cv-import.mjs --file <resume.(md|txt|pdf)> | --sync-profile');
    process.exit(2);
  }

  const ext = extname(filePath).toLowerCase();

  // Preserve the original upload.
  const uploadsDir = join(USER_ROOT, 'data', 'cv-uploads');
  mkdirSync(uploadsDir, { recursive: true });
  const archived = join(uploadsDir, `${new Date().toISOString().slice(0, 10)}-${basename(filePath)}`);
  copyFileSync(filePath, archived);

  let markdown = '';
  if (ext === '.md' || ext === '.txt') {
    markdown = readFileSync(filePath, 'utf-8').trim();
  } else if (ext === '.pdf') {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('❌ PDF import needs GEMINI_API_KEY in .env (or send your resume as .md/.txt, or paste the text)');
      process.exit(1);
    }
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const modelName = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
    const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
      model: modelName,
      generationConfig: { temperature: 0 },
    });
    console.log(`🤖 Transcribing PDF resume to markdown with ${modelName}...`);
    const result = await model.generateContent([
      {
        inlineData: {
          mimeType: 'application/pdf',
          data: readFileSync(filePath).toString('base64'),
        },
      },
      {
        text: 'Transcribe this resume into clean markdown. Preserve EVERY fact exactly — names, dates, employers, titles, metrics, skills, education, links. Use # for the name, ## for section headings, bullet lists for experience items. Do not add, embellish, or reword content. Output only the markdown.',
      },
    ]);
    markdown = result.response.text().trim()
      .replace(/^```(?:markdown)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
  } else {
    console.error(`❌ Unsupported format "${ext}" — send .md, .txt, or .pdf (for DOCX, export to PDF first)`);
    process.exit(1);
  }

  if (markdown.length < 200) {
    console.error(`❌ Imported CV looks too short (${markdown.length} chars) — check the upload and try again`);
    process.exit(1);
  }

  writeFileSync(cvPath, markdown + '\n');
  const updated = syncProfileFromCv(markdown, profilePath);
  console.log(`✅ CV imported (${markdown.length} chars). Original archived: ${archived}`);
  if (updated.length) console.log(`👤 Profile synced from resume: ${updated.join(', ')}`);
  console.log(`CV_PATH: ${cvPath}`);
}
