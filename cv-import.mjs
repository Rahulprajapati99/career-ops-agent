#!/usr/bin/env node

/**
 * cv-import.mjs — Family Edition: import an uploaded resume into cv.md.
 *
 * Accepts .md / .txt (saved near-verbatim) or .pdf (transcribed to markdown
 * with Gemini's inline-document support). The original upload is preserved
 * under data/cv-uploads/ so nothing is lost if the transcription needs a
 * manual touch-up. DOCX is not supported — export to PDF or paste text.
 *
 * Usage:
 *   node cv-import.mjs --file <uploaded-resume.(md|txt|pdf)>
 *
 * Env: CAREER_OPS_USER_ROOT (target user root; default cwd),
 *      GEMINI_API_KEY + GEMINI_MODEL (PDF transcription only).
 *
 * Output marker (for the Telegram bot / web dashboard):
 *   CV_PATH: <path>
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

const USER_ROOT = process.env.CAREER_OPS_USER_ROOT
  ? resolve(process.env.CAREER_OPS_USER_ROOT)
  : process.cwd();

const args = process.argv.slice(2);
let filePath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file' && args[i + 1]) filePath = args[++i];
}
if (!filePath || !existsSync(filePath)) {
  console.error('Usage: node cv-import.mjs --file <resume.(md|txt|pdf)>');
  process.exit(2);
}

const ext = extname(filePath).toLowerCase();
const cvPath = join(USER_ROOT, 'cv.md');

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
console.log(`✅ CV imported (${markdown.length} chars). Original archived: ${archived}`);
console.log(`CV_PATH: ${cvPath}`);
