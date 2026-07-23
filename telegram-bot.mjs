/**
 * telegram-bot.mjs — Family Edition multi-user Telegram bot.
 *
 * Serves up to N allowlisted family members, each with a fully isolated data
 * root under users/<telegram_id>/ (see user-env.mjs / run-as-user.mjs). Every
 * pipeline script runs with cwd + CAREER_OPS_* env bound to the requesting
 * user's root, so evaluations, resumes, cover letters, and trackers never mix.
 *
 * Commands:
 *   (send URL)      — Extract JD, evaluate against YOUR cv, offer tailoring
 *   (paste JD text) — Evaluate pasted job description (no URL needed)
 *   (send file)     — Import a resume (.md/.txt/.pdf) as your cv.md
 *   /start          — Welcome + onboarding status
 *   /help           — List available commands
 *   /whoami         — Your Telegram id + data root (for the allowlist)
 *   /setcv          — Import/replace your resume (upload or paste)
 *   /jobs           — Recent jobs in your pipeline
 *   /scan           — Scan YOUR portals for new matching jobs
 *   /status [co]    — Tracked applications (optionally filter by company)
 *   /tailor         — Tailor resume from last evaluation
 *   /cover          — Generate a cover-letter PDF for the last evaluation
 *   /applykit       — Full apply kit: tailored CV + cover letter + prefill notes
 *   /apply <url>    — ATS prefill cheat-sheet (never submits)
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN    — bot token (required)
 *   TELEGRAM_ALLOWED_IDS  — comma-separated Telegram user ids (required; the
 *                           bot refuses everyone else and tells them their id)
 *
 * Requires: npm install (node-telegram-bot-api is a declared dependency)
 */

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { REPO_ROOT, userRootFor, buildUserEnv, isValidUserId } from './user-env.mjs';
import { scaffoldUser } from './scaffold-user.mjs';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Environment & setup
// ---------------------------------------------------------------------------
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('❌ TELEGRAM_BOT_TOKEN missing in .env');
  process.exit(1);
}

const ALLOWED_IDS = new Set(
  (process.env.TELEGRAM_ALLOWED_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
if (ALLOWED_IDS.size === 0) {
  console.error('❌ TELEGRAM_ALLOWED_IDS missing in .env — add the family Telegram ids, comma-separated');
  process.exit(1);
}

if (!process.env.GEMINI_API_KEY) {
  console.warn('⚠️  GEMINI_API_KEY is not set — evaluation, tailoring, and cover letters WILL fail until it is added to .env and the bot is restarted.');
}

const bot = new TelegramBot(token, { polling: true });
console.log(`🤖 Career-Ops Family Bot online — serving ${ALLOWED_IDS.size} allowlisted user(s).`);

// ---------------------------------------------------------------------------
// Per-user routing — every script runs inside users/<id>/
// ---------------------------------------------------------------------------
/** Quote a filesystem path for a shell command line. */
const q = (p) => `"${p}"`;
/**
 * Command prefix to run a system script: node executable + absolute script
 * path, both quoted. The explicit node prefix is load-bearing — a bare
 * "script.mjs args" makes Windows cmd open the file via its file association
 * (silent empty "success") and makes Linux sh fail on the missing exec bit.
 */
const script = (name) => `${q(process.execPath)} ${q(path.join(REPO_ROOT, name))}`;

/**
 * Resolve (and lazily scaffold) the calling user's isolated context.
 * @returns {{ root: string, opts: object, longOpts: object }}
 */
function userCtx(chatId) {
  const id = String(chatId);
  if (!isValidUserId(id)) throw new Error(`unroutable chat id: ${chatId}`);
  const root = userRootFor(id);
  if (!fs.existsSync(root)) {
    scaffoldUser(id);
    console.log(`👤 Scaffolded new user root: ${root}`);
  }
  const env = { ...process.env, ...buildUserEnv(root) };
  const opts = { maxBuffer: 1024 * 1024 * 5, cwd: root, env };
  return { root, opts, longOpts: { ...opts, timeout: 300_000 } };
}

/** True when the user's cv.md is still the scaffold placeholder. */
function cvIsPlaceholder(root) {
  const cvPath = path.join(root, 'cv.md');
  if (!fs.existsSync(cvPath)) return true;
  const cv = fs.readFileSync(cvPath, 'utf-8');
  return cv.length < 300 || cv.includes('Placeholder created by scaffold-user.mjs');
}

// ---------------------------------------------------------------------------
// Per-chat state (last evaluation context; onboarding mode)
// ---------------------------------------------------------------------------
const chatState = new Map();
const urlRegex = /(https?:\/\/[^\s]+)/g;

/**
 * Strip the wrapping a URL picks up from chat: angle brackets (users copy the
 * `<url>` usage placeholder literally), quotes/backticks, and trailing
 * sentence punctuation. Without this, `/apply <https://…>` reached the ATS
 * layer as an invalid URL and failed with a misleading "unsupported ATS".
 */
function cleanUrl(raw) {
  return String(raw || '')
    .trim()
    .replace(/^[<"'`\s]+/, '')
    .replace(/[>"'`\s]+$/, '')
    .replace(/[.,);]+$/, '')
    .trim();
}

function getLatestFile(dir, suffix) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((f) => {
      if (!fs.statSync(path.join(dir, f)).isFile()) return false;
      return suffix ? f.endsWith(suffix) : true;
    })
    .map((f) => ({ file: f, time: fs.statSync(path.join(dir, f)).mtime.getTime() }))
    .sort((a, b) => b.time - a.time);
  return files.length > 0 ? path.join(dir, files[0].file) : null;
}

function parseScoreSummary(stdout) {
  const match = stdout.match(/---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/);
  if (!match) return null;
  const block = match[1];
  const extract = (key) => {
    const line = block.split('\n').find((l) => l.trimStart().startsWith(`${key}:`));
    return line ? line.split(':').slice(1).join(':').trim() : 'unknown';
  };
  return {
    company: extract('COMPANY'),
    role: extract('ROLE'),
    score: parseFloat(extract('SCORE')) || 0,
    archetype: extract('ARCHETYPE'),
    legitimacy: extract('LEGITIMACY'),
  };
}

const parseMarker = (stdout, marker) => {
  const match = stdout.match(new RegExp(`${marker}:\\s*(.+)`));
  return match ? match[1].trim() : null;
};

/** Strip secrets from text destined for a Telegram message. */
function redactSecrets(text) {
  let out = String(text || '');
  for (const key of ['GEMINI_API_KEY', 'TELEGRAM_BOT_TOKEN', 'OPENAI_API_KEY', 'ADZUNA_APP_KEY', 'ADZUNA_APP_ID']) {
    const val = process.env[key];
    if (val) out = out.split(val).join('[redacted]');
  }
  return out.replace(/([?&]key=)[^&\s]+/gi, '$1[redacted]');
}

/**
 * Build a plain-text error reply that names the actual cause. Plain text on
 * purpose: raw error detail contains Markdown-hostile characters, and a
 * parse_mode failure would swallow the message entirely.
 * @param {Error & {stderr?: string, stdout?: string}} error
 */
function friendlyError(error) {
  const errMsg = (error && (error.message || String(error))) || '';
  if (/429|quota|rate limit|QUOTA_EXHAUSTED/i.test(errMsg)) {
    return '⚠️ Rate limit hit — the free Gemini quota is temporarily exhausted. Wait ~60s and retry (daily cap resets tomorrow).';
  }
  if (/GEMINI_API_KEY/i.test(`${errMsg}${error?.stderr || ''}${error?.stdout || ''}`)) {
    return '⚙️ The server is missing its GEMINI_API_KEY — add it to .env on the host and restart the bot. Evaluation, tailoring, and cover letters need it.';
  }
  if (/jd-fetch|browser-extract|playwright|Navigation/i.test(errMsg)) {
    const tail = redactSecrets(((error?.stderr || '').trim() || errMsg).split('\n').filter(Boolean).slice(-2).join(' · ')).slice(0, 250);
    return `❌ Could not extract the job description — the page may need login or block bots. Copy the JD text and paste it here instead.\n\n🔧 Cause: ${tail || 'unknown'}\n(Send /diag if this keeps happening.)`;
  }
  // Generic: surface the tail of the real error so failures are actionable
  // without SSH-ing into the host for logs.
  const rawDetail = (error?.stderr || '').trim() || (error?.stdout || '').trim() || errMsg;
  const detail = redactSecrets(rawDetail.split('\n').filter(Boolean).slice(-3).join(' · ')).slice(0, 350);
  return `❌ Something went wrong.\n\nCause: ${detail || 'unknown — check the bot logs'}\n\nRetry in a moment; if it persists, send this message to the admin.`;
}

// ---------------------------------------------------------------------------
// Evaluation — from a URL or pasted JD text
// ---------------------------------------------------------------------------
async function evaluateJd(chatId, { url = null, pastedText = null }) {
  const { root, longOpts } = userCtx(chatId);

  if (cvIsPlaceholder(root)) {
    await bot.sendMessage(chatId,
      '👋 Before I can evaluate jobs for you, I need your resume.\n\n' +
      'Send it now as a *.pdf*, *.md*, or *.txt* file — or type /setcv and paste the text.',
      { parse_mode: 'Markdown' });
    return;
  }

  const jdFile = path.join(root, 'data', 'temp_jd.txt');
  try {
    if (url) {
      await bot.sendMessage(chatId, `⏳ Extracting job description...\n🔗 ${url}`);
      // API-first (Ashby/Greenhouse/Lever public APIs), browser fallback.
      await execAsync(`${script('jd-fetch.mjs')} "${url}" > ${q(jdFile)}`, longOpts);
      const jd = fs.existsSync(jdFile) ? fs.readFileSync(jdFile, 'utf-8') : '';
      if (jd.trim().length < 100) {
        throw Object.assign(new Error('jd-fetch: extracted JD is empty'), { stderr: 'jd-fetch produced no usable text' });
      }
    } else {
      fs.writeFileSync(jdFile, pastedText);
      await bot.sendMessage(chatId, '⏳ Got the pasted job description.');
    }
    await bot.sendMessage(chatId, '✅ Evaluating against your CV...');

    const { stdout: evalOutput } = await execAsync(
      `${script('gemini-eval.mjs')} --file ${q(jdFile)}`,
      longOpts,
    );

    const summary = parseScoreSummary(evalOutput);
    const reportRel = evalOutput.match(/Report saved:\s*(.+\.md)/)?.[1]?.trim() || null;
    const reportPath = reportRel
      ? path.resolve(root, reportRel)
      : getLatestFile(path.join(root, 'reports'), '.md');

    if (!summary) {
      await bot.sendMessage(chatId, '⚠️ Evaluation finished but the summary could not be parsed. Check the bot logs.');
      return;
    }

    chatState.set(chatId, {
      jdFile, reportPath, url,
      company: summary.company, role: summary.role, score: summary.score,
      tailored: false, pdfPath: null, coverPdf: null, timestamp: Date.now(),
    });

    const scoreEmoji = summary.score >= 4 ? '🟢' : summary.score >= 3 ? '🟡' : '🔴';
    let replyText =
      `🎯 *Evaluation Complete*\n\n` +
      `🏢 *Company:* ${summary.company}\n` +
      `💼 *Role:* ${summary.role}\n` +
      `${scoreEmoji} *Score:* ${summary.score}/5\n` +
      `🎭 *Archetype:* ${summary.archetype}\n` +
      `🔒 *Legitimacy:* ${summary.legitimacy}\n\n` +
      `📊 Report saved & tracked.`;
    replyText += summary.score >= 3.5
      ? `\n\n✨ *High match!* Tailor your resume for this role?`
      : `\n\n📉 Low match score — tailor anyway?`;

    await bot.sendMessage(chatId, replyText, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '📄 Tailor My Resume', callback_data: 'tailor_yes' },
          { text: '❌ Skip', callback_data: 'tailor_skip' },
        ]],
      },
    });
  } catch (error) {
    console.error(`[${chatId}] evaluate error:`, error);
    await bot.sendMessage(chatId, friendlyError(error));
  }
}

// ---------------------------------------------------------------------------
// Tailor — tailored CV + PDF (per-user), ATS-aware
// ---------------------------------------------------------------------------
/** Run the zero-token ATS keyword scan of the current JD vs a CV/HTML. */
async function atsScan(chatId, jdFile, { html = null } = {}) {
  const { root, opts } = userCtx(chatId);
  const htmlArg = html ? ` --html ${q(html)}` : '';
  const { stdout } = await execAsync(
    `${script('ats-match.mjs')} --jd ${q(jdFile)} --cv ${q(path.join(root, 'cv.md'))}${htmlArg} --json`,
    opts,
  );
  const s = stdout.indexOf('{');
  const e = stdout.lastIndexOf('}');
  return JSON.parse(stdout.slice(s, e + 1));
}

async function handleTailor(chatId, { force = false } = {}) {
  const { longOpts } = userCtx(chatId);
  const state = chatState.get(chatId);

  if (!state?.jdFile || !state?.reportPath) {
    await bot.sendMessage(chatId, '❌ No recent evaluation. Send a job URL (or paste a JD) first.');
    return;
  }
  if (state.tailored && state.pdfPath) {
    await bot.sendMessage(chatId, '✅ Already tailored for this evaluation — /cover or /applykit are the next steps.');
    return;
  }
  if (!fs.existsSync(state.jdFile) || !fs.existsSync(state.reportPath)) {
    await bot.sendMessage(chatId, '❌ Evaluation files no longer available. Please resend the job URL.');
    return;
  }

  // Self-awareness pre-check (zero-token, no LLM): if the base CV already
  // covers the JD's keywords with no must-have gaps, tailoring is unlikely to
  // help — offer to skip instead of burning an LLM call.
  let gaps = [];
  try {
    const scan = await atsScan(chatId, state.jdFile);
    state.atsBefore = scan.before;
    gaps = (scan.missingMustHave?.length ? scan.missingMustHave : scan.missing) || [];
    chatState.set(chatId, state);
    if (!force && scan.before >= 80 && (scan.missingMustHave || []).length === 0) {
      await bot.sendMessage(chatId,
        `🧠 Your current resume already matches *${scan.before}%* of this JD's keywords with no missing must-haves — tailoring is unlikely to move the needle. Spend the LLM call anyway?`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[
            { text: '✂️ Tailor anyway', callback_data: 'tailor_force' },
            { text: '👍 Keep my resume as-is', callback_data: 'tailor_skip' },
          ]] },
        });
      return;
    }
  } catch (scanErr) {
    console.error(`[${chatId}] pre-tailor ATS scan failed (non-fatal):`, scanErr.message);
  }

  await bot.sendMessage(chatId,
    `⏳ Tailoring your resume for *${state.company}* — *${state.role}*... (30–90s)`,
    { parse_mode: 'Markdown' });

  try {
    // Feed the keyword gaps into the tailor so it surfaces covered-but-hidden
    // terms and never drops existing ones (grounding enforced in the prompt).
    const gapsArg = gaps.length ? ` --ats-gaps "${gaps.slice(0, 10).join('; ').replace(/"/g, '')}"` : '';
    const { stdout } = await execAsync(
      `${script('gemini-tailor.mjs')} --jd ${q(state.jdFile)} --report ${q(state.reportPath)}${gapsArg}`,
      longOpts,
    );
    const htmlPath = parseMarker(stdout, 'HTML_PATH');
    if (!htmlPath || !fs.existsSync(htmlPath)) {
      await bot.sendMessage(chatId, '❌ Tailoring finished but the output HTML was not found.');
      return;
    }

    await bot.sendMessage(chatId, '✅ CV tailored. Generating PDF...');
    const pdfPath = htmlPath.replace(/\.html$/, '.pdf');
    await execAsync(`${script('generate-pdf.mjs')} ${q(htmlPath)} ${q(pdfPath)}`, longOpts);

    if (fs.existsSync(pdfPath)) {
      await bot.sendDocument(chatId, pdfPath, {
        caption: `📄 Tailored CV — ${state.company} · ${state.role} (score ${state.score}/5)`,
      });
      state.pdfPath = pdfPath;
    } else {
      await bot.sendMessage(chatId, '⚠️ PDF generation failed — sending the HTML instead.');
      await bot.sendDocument(chatId, htmlPath, { caption: `📄 Tailored CV (HTML) — ${state.company}` });
    }
    state.tailored = true;
    state.htmlPath = htmlPath;
    chatState.set(chatId, state);

    // ATS match report — before (original cv.md) vs after (tailored HTML),
    // with an honest warning if the tailored version scores WORSE.
    try {
      const scan = await atsScan(chatId, state.jdFile, { html: htmlPath });
      const { before, after } = scan;
      if (Number.isFinite(before) && Number.isFinite(after)) {
        const missing = (scan.missingMustHave?.length ? scan.missingMustHave : scan.missing || []).slice(0, 8);
        let atsMsg = `📊 *ATS keyword match:* ${before}% → *${after}%*`;
        if (missing.length) atsMsg += `\n🔎 Still missing: _${missing.join(', ')}_`;
        if (after < before) {
          atsMsg += `\n\n⚠️ *The tailored version scores LOWER on keywords than your original.* ` +
            `That usually means condensing dropped covered terms. Your original resume may be the stronger ATS bet here — ` +
            `or resend the URL and /tailor again for another attempt.`;
        } else {
          atsMsg += '\n_(Missing terms are only added when your CV truly supports them — fabrication is blocked.)_';
        }
        await bot.sendMessage(chatId, atsMsg, { parse_mode: 'Markdown' });
      }
    } catch (atsErr) {
      console.error(`[${chatId}] ats-match error (non-fatal):`, atsErr.message);
    }

    await bot.sendMessage(chatId,
      `✅ *Done!* Next steps:\n• /cover — cover-letter PDF\n• /applykit — full apply kit\n• /status — your tracker`,
      { parse_mode: 'Markdown' });
  } catch (error) {
    console.error(`[${chatId}] tailor error:`, error);
    await bot.sendMessage(chatId, friendlyError(error));
  }
}

// ---------------------------------------------------------------------------
// Cover letter — Gemini payload → rendered PDF (per-user)
// ---------------------------------------------------------------------------
async function handleCover(chatId, { silent = false } = {}) {
  const { longOpts } = userCtx(chatId);
  const state = chatState.get(chatId);

  if (!state?.reportPath || !fs.existsSync(state.reportPath)) {
    if (!silent) await bot.sendMessage(chatId, '❌ No recent evaluation. Send a job URL first, then /cover.');
    return null;
  }
  if (state.coverPdf && fs.existsSync(state.coverPdf)) return state.coverPdf;

  if (!silent) {
    await bot.sendMessage(chatId,
      `⏳ Writing a cover letter for *${state.company}* — *${state.role}*... (30–60s)`,
      { parse_mode: 'Markdown' });
  }

  try {
    const jdArg = state.jdFile && fs.existsSync(state.jdFile) ? ` --jd ${q(state.jdFile)}` : '';
    const { stdout } = await execAsync(
      `${script('gemini-cover.mjs')} --report ${q(state.reportPath)}${jdArg}`,
      longOpts,
    );
    const coverPdf = parseMarker(stdout, 'COVER_PDF_PATH');
    if (!coverPdf || !fs.existsSync(coverPdf)) {
      if (!silent) await bot.sendMessage(chatId, '❌ Cover letter generation failed — check the bot logs.');
      return null;
    }
    state.coverPdf = coverPdf;
    chatState.set(chatId, state);
    if (!silent) {
      await bot.sendDocument(chatId, coverPdf, {
        caption: `✉️ Cover letter — ${state.company} · ${state.role}`,
      });
    }
    return coverPdf;
  } catch (error) {
    console.error(`[${chatId}] cover error:`, error);
    if (!silent) await bot.sendMessage(chatId, friendlyError(error));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Apply kit — tailored CV + cover letter + prefill notes, delivered together
// ---------------------------------------------------------------------------
const PREFILL_HOSTS = /(^|\.)greenhouse\.io$|(^|\.)ashbyhq\.com$|(^|\.)lever\.co$/i;

/**
 * Companies often embed Greenhouse on their own domain (e.g.
 * netbrain.com/...?career_jobid=507...). Resolve such pages to the canonical
 * boards.greenhouse.io URL by scanning the page for the embed board slug and
 * pairing it with the job id from the URL (or the page). Returns the original
 * URL when nothing can be resolved.
 */
async function resolveEmbeddedAtsUrl(rawUrl) {
  const url = cleanUrl(rawUrl);
  try {
    const u = new URL(url);
    if (PREFILL_HOSTS.test(u.hostname)) return url; // already canonical
    const jobIdFromUrl = ['gh_jid', 'career_jobid', 'jobid', 'jid', 'job']
      .map((k) => u.searchParams.get(k))
      .find((v) => v && /^\d{5,}$/.test(v));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let html = '';
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; career-ops/1.3)' },
        signal: controller.signal,
      });
      if (res.ok) html = await res.text();
    } finally {
      clearTimeout(timer);
    }
    if (!html) return url;

    const org = html.match(/boards\.greenhouse\.io\/(?:embed\/job_board\/js\?for=|embed\/job_app\?for=|v1\/boards\/)?([a-z0-9_-]{2,})/i)?.[1]
      || html.match(/greenhouse\.io\/embed\/job_board\?for=([a-z0-9_-]{2,})/i)?.[1];
    const jobId = jobIdFromUrl || html.match(/gh_jid=(\d{5,})/)?.[1];
    if (org && jobId && !['embed', 'v1', 'boards'].includes(org)) {
      return `https://boards.greenhouse.io/${org}/jobs/${jobId}`;
    }
  } catch { /* fall through to the original URL */ }
  return url;
}
async function handleApplyKit(chatId) {
  const { opts } = userCtx(chatId);
  const state = chatState.get(chatId);

  if (!state?.reportPath) {
    await bot.sendMessage(chatId, '❌ No recent evaluation. Flow: send URL → /tailor → /applykit.');
    return;
  }
  if (!state.tailored || !state.pdfPath || !fs.existsSync(state.pdfPath)) {
    await bot.sendMessage(chatId, '📄 Your CV is not tailored yet — running /tailor first, then send /applykit again.');
    return handleTailor(chatId);
  }

  await bot.sendMessage(chatId, `📦 Assembling your apply kit for *${state.company}*...`, { parse_mode: 'Markdown' });

  // 1) Tailored CV (already exists)
  await bot.sendDocument(chatId, state.pdfPath, { caption: `1/3 📄 Tailored CV — ${state.company}` });

  // 2) Cover letter (generate if missing)
  const coverPdf = await handleCover(chatId, { silent: true });
  if (coverPdf) {
    await bot.sendDocument(chatId, coverPdf, { caption: `2/3 ✉️ Cover letter — ${state.company}` });
  } else {
    await bot.sendMessage(chatId, '2/3 ⚠️ Cover letter could not be generated (retry with /cover).');
  }

  // 3) ATS prefill notes (when the original application URL is known)
  if (state.url) {
    try {
      const prefillUrl = await resolveEmbeddedAtsUrl(state.url);
      const { stdout } = await execAsync(
        `${script('prepare-application.mjs')} --url "${prefillUrl}" --pdf ${q(state.pdfPath)}`,
        opts,
      );
      const notes = stdout.trim();
      if (notes) {
        const via = prefillUrl !== state.url ? ` _(resolved the branded page to its Greenhouse board)_\n` : '';
        await bot.sendMessage(chatId,
          `3/3 📋 *ATS prefill notes:*${via}\n\`\`\`\n${notes.slice(0, 3300)}\n\`\`\``,
          { parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(chatId, '3/3 ℹ️ The ATS returned no prefill fields for this posting.');
      }
    } catch (err) {
      console.error(`[${chatId}] prefill error:`, (err.stderr || err.message || '').slice(0, 300));
      await bot.sendMessage(chatId,
        '3/3 ℹ️ Prefill notes not available — this page hosts its application on a custom/unrecognized ATS. ' +
        'Your tailored CV and cover letter above are everything you need; open the posting and fill the form directly.');
    }
  } else {
    await bot.sendMessage(chatId, '3/3 ℹ️ No application URL on file (JD was pasted) — no prefill notes.');
  }

  await bot.sendMessage(chatId,
    '✅ *Apply kit delivered.* Review everything, then apply on the site yourself — I never submit for you. 🚦',
    { parse_mode: 'Markdown' });
}

// ---------------------------------------------------------------------------
// CV import — document upload or pasted text
// ---------------------------------------------------------------------------
async function handleDocument(chatId, doc) {
  const { root, longOpts } = userCtx(chatId);
  const name = doc.file_name || 'upload';
  const ext = path.extname(name).toLowerCase();

  if (!['.pdf', '.md', '.txt'].includes(ext)) {
    await bot.sendMessage(chatId, `❌ "${ext}" is not supported for resume import — send .pdf, .md, or .txt (export DOCX to PDF first).`);
    return;
  }
  if ((doc.file_size || 0) > 10 * 1024 * 1024) {
    await bot.sendMessage(chatId, '❌ File too large (max 10 MB).');
    return;
  }

  await bot.sendMessage(chatId, `⏳ Importing "${name}" as your resume...`);
  try {
    const downloadDir = path.join(root, 'data', 'cv-uploads');
    fs.mkdirSync(downloadDir, { recursive: true });
    const downloaded = await bot.downloadFile(doc.file_id, downloadDir);

    const { stdout } = await execAsync(`${script('cv-import.mjs')} --file ${q(downloaded)}`, longOpts);
    const cvPath = parseMarker(stdout, 'CV_PATH');
    if (cvPath && fs.existsSync(cvPath)) {
      const size = fs.readFileSync(cvPath, 'utf-8').length;
      await bot.sendMessage(chatId,
        `✅ *Resume imported!* (${size} chars)\n\nYou're all set — send me any job URL and I'll evaluate it against your CV.`,
        { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(chatId, '❌ Import failed — try a different format, or /setcv to paste the text.');
    }
  } catch (error) {
    console.error(`[${chatId}] cv import error:`, error);
    await bot.sendMessage(chatId, friendlyError(error));
  }
}

async function handleCvPaste(chatId, text) {
  const { root } = userCtx(chatId);
  if (text.length < 300) {
    await bot.sendMessage(chatId, '❌ That looks too short for a resume. Paste the full text (or upload a file).');
    return;
  }
  fs.writeFileSync(path.join(root, 'cv.md'), text.trim() + '\n');
  const state = chatState.get(chatId) || {};
  delete state.awaitingCv;
  chatState.set(chatId, state);
  await bot.sendMessage(chatId,
    `✅ *Resume saved!* (${text.length} chars)\n\nSend me any job URL and I'll evaluate it against your CV.`,
    { parse_mode: 'Markdown' });
}

// ---------------------------------------------------------------------------
// Jobs, scan, status
// ---------------------------------------------------------------------------
async function handleJobs(chatId) {
  const { root } = userCtx(chatId);
  const pipelinePath = path.join(root, 'data', 'pipeline.md');
  if (!fs.existsSync(pipelinePath)) {
    await bot.sendMessage(chatId, '📭 Your pipeline is empty — run /scan to discover jobs, or send me a URL.');
    return;
  }
  const rows = fs.readFileSync(pipelinePath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().startsWith('- [ ]'));
  if (rows.length === 0) {
    await bot.sendMessage(chatId, '📭 No pending jobs in your pipeline — run /scan to discover new ones.');
    return;
  }
  let msg = `🗂 *Your pipeline — ${rows.length} pending job(s):*\n\n`;
  for (const row of rows.slice(-12).reverse()) {
    const parts = row.replace(/^- \[ \]\s*/, '').split('|').map((s) => s.trim());
    const [url, company, title, location] = parts;
    msg += `🏢 *${company || '?'}* — ${title || '?'}\n`;
    if (location) msg += `   📍 ${location}\n`;
    if (url) msg += `   ${url}\n`;
    msg += '\n';
  }
  if (rows.length > 12) msg += `_...and ${rows.length - 12} more in data/pipeline.md_`;
  await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', disable_web_page_preview: true });
}

async function handleScan(chatId) {
  const { opts } = userCtx(chatId);
  await bot.sendMessage(chatId, '⏳ Scanning your portals for new matching jobs... (2–5 min)');
  try {
    const { stdout } = await execAsync(`${script('scan.mjs')}`, { ...opts, timeout: 600_000 });
    const added = stdout.match(/(\d+)\s+new/i)?.[1];
    const tail = stdout.trim().split('\n').slice(-25).join('\n');
    await bot.sendMessage(chatId,
      `🔍 *Scan complete.*${added ? ` ${added} new job(s) added.` : ''}\n\n\`\`\`\n${tail.slice(0, 3000)}\n\`\`\`\n\nUse /jobs to browse them.`,
      { parse_mode: 'Markdown' });
  } catch (error) {
    console.error(`[${chatId}] scan error:`, error);
    await bot.sendMessage(chatId, '❌ Scan failed — check portals.yml in your data root and the bot logs.');
  }
}

async function handleStatus(chatId, companyFilter) {
  const { opts, root } = userCtx(chatId);
  try {
    const cmd = companyFilter
      ? `${script('tracker.mjs')} query --company "${companyFilter}" --json --limit 20`
      : `${script('tracker.mjs')} query --json --limit 20`;
    const { stdout } = await execAsync(cmd, opts);

    // tracker.mjs may print informational lines (e.g. "index stale —
    // resyncing") before the JSON — extract the array instead of parsing raw.
    let rows = null;
    const s = stdout.indexOf('[');
    const e = stdout.lastIndexOf(']');
    if (s !== -1 && e > s) {
      try { rows = JSON.parse(stdout.slice(s, e + 1)); } catch { rows = null; }
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      await bot.sendMessage(chatId,
        companyFilter ? `📊 No applications found for "${companyFilter}".`
          : '📊 Nothing tracked yet — send a job URL to get started!');
      return;
    }
    let msg = companyFilter
      ? `📊 *Applications — "${companyFilter}":*\n\n`
      : `📊 *Recent applications (${rows.length}):*\n\n`;
    for (const row of rows.slice(0, 15)) {
      const scoreEmoji = (row.score || 0) >= 4 ? '🟢' : (row.score || 0) >= 3 ? '🟡' : '🔴';
      msg += `${scoreEmoji} *${row.company || '?'}* — ${row.role || '?'}\n`;
      msg += `   ${row.score || '?'}/5 · ${row.status || '?'} · ${row.date || ''}\n\n`;
    }
    if (rows.length > 15) msg += `_...and ${rows.length - 15} more_`;
    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
  } catch (error) {
    // Tracker not synced — fall back to the raw file inside THIS user's root.
    const trackerPath = path.join(root, 'data', 'applications.md');
    if (fs.existsSync(trackerPath)) {
      const lines = fs.readFileSync(trackerPath, 'utf-8')
        .split('\n').filter((l) => l.startsWith('|') && !l.includes('---'));
      if (lines.length > 1) {
        const recent = lines.slice(Math.max(1, lines.length - 10)).join('\n');
        await bot.sendMessage(chatId,
          `📊 *Recent applications:*\n\n\`\`\`\n${recent.slice(0, 3300)}\n\`\`\``,
          { parse_mode: 'Markdown' });
        return;
      }
    }
    await bot.sendMessage(chatId, '📊 Nothing tracked yet — send a job URL to get started!');
  }
}

// ---------------------------------------------------------------------------
// Apply (prefill cheat-sheet only — never submits)
// ---------------------------------------------------------------------------
async function handleApply(chatId, rawUrl) {
  const { opts } = userCtx(chatId);
  const applyUrl = cleanUrl(rawUrl);
  if (!applyUrl || !/^https?:\/\//i.test(applyUrl)) {
    await bot.sendMessage(chatId, 'Usage: /apply https://your-application-url\n(paste the link plainly — no < > around it)');
    return;
  }
  // Use the CV tailored for THE JOB CURRENTLY IN CONTEXT — never a stray
  // "latest file", which previously attached another company's cover letter.
  const state = chatState.get(chatId);
  const pdfPath = state?.pdfPath;
  if (!pdfPath || !fs.existsSync(pdfPath)) {
    await bot.sendMessage(chatId,
      '⚠️ I don\'t have a tailored resume in memory for this session. Send the job URL, tap *Tailor My Resume*, then run /apply — so I attach the CV tailored for *this* role.',
      { parse_mode: 'Markdown' });
    return;
  }
  await bot.sendMessage(chatId, `⏳ Generating ATS prefill cheat-sheet for your *${state.company}* CV...`, { parse_mode: 'Markdown' });
  try {
    const prefillUrl = await resolveEmbeddedAtsUrl(applyUrl);
    const { stdout } = await execAsync(
      `${script('prepare-application.mjs')} --url "${prefillUrl}" --pdf ${q(pdfPath)}`,
      opts,
    );
    const output = stdout.trim();
    if (output) {
      await bot.sendMessage(chatId,
        `📋 *ATS prefill guide:*\n\n\`\`\`\n${output.slice(0, 3300)}\n\`\`\``,
        { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(chatId, '⚠️ The ATS returned no prefill fields for this posting.');
    }
  } catch (err) {
    console.error(`[${chatId}] apply prefill error:`, (err.stderr || err.message || '').slice(0, 300));
    await bot.sendMessage(chatId,
      '⚠️ No prefill guide for this URL — it hosts its application on a custom/unrecognized ATS. Apply directly on the page with your tailored documents.');
  }
}

// ---------------------------------------------------------------------------
// Onboarding & meta
// ---------------------------------------------------------------------------
async function handleStart(chatId) {
  const { root } = userCtx(chatId);
  const needsCv = cvIsPlaceholder(root);
  await bot.sendMessage(chatId,
    `👋 *Welcome to the Career-Ops Family Bot*\n\n` +
    `Your private workspace is ready — nothing you do here is visible to other users.\n\n` +
    (needsCv
      ? `🪪 *First step:* send me your resume as a *.pdf*, *.md*, or *.txt* file (or /setcv to paste it). ` +
        `Everything else — evaluating, tailoring, cover letters — builds on it.\n\n`
      : `✅ Your resume is on file. Send any job URL to evaluate it!\n\n`) +
    `Type /help for all commands.`,
    { parse_mode: 'Markdown' });
}

async function handleHelp(chatId) {
  await bot.sendMessage(chatId,
    `📖 *Commands*\n\n` +
    `🔗 Send a *job URL* — extract + evaluate against your CV\n` +
    `📝 Paste a *JD text* — same, without a URL\n` +
    `📎 Send a *file* — import resume (.pdf/.md/.txt)\n\n` +
    `*Pipeline:*\n` +
    `/jobs — pending jobs in your pipeline\n` +
    `/scan — scan your portals for new jobs\n` +
    `/status [company] — your tracked applications\n\n` +
    `*Documents:*\n` +
    `/tailor — tailor resume (last evaluation)\n` +
    `/cover — cover-letter PDF\n\n` +
    `*Setup:*\n` +
    `/setcv — import/replace your resume\n` +
    `/whoami — your id + data root\n` +
    `/diag — server health check\n\n` +
    `_I prepare everything but never submit applications — you stay in control._`,
    { parse_mode: 'Markdown' });
}

async function handleWhoami(chatId) {
  const { root } = userCtx(chatId);
  await bot.sendMessage(chatId,
    `🪪 *Your identity*\n\nTelegram id: \`${chatId}\`\nData root: \`users/${chatId}/\`\nCV on file: ${cvIsPlaceholder(root) ? '❌ not yet' : '✅ yes'}`,
    { parse_mode: 'Markdown' });
}

/** /diag — server health report, so failures are debuggable from Telegram. */
async function handleDiag(chatId) {
  const lines = ['🩺 Server diagnostics', ''];

  // Code version — is the VM actually running the latest fix?
  try {
    const { stdout } = await execAsync('git log --oneline -1', { cwd: REPO_ROOT });
    lines.push(`Code: ${stdout.trim().slice(0, 60)}`);
  } catch { lines.push('Code: git unavailable'); }

  lines.push(`Node: ${process.version} ${typeof fetch === 'function' ? '(fetch ✅)' : '(fetch ❌ — Node ≥18 required for API extraction!)'}`);
  lines.push(`GEMINI_API_KEY: ${process.env.GEMINI_API_KEY ? '✅ set' : '❌ MISSING — eval/tailor/cover will fail'}`);
  lines.push(`ADZUNA keys: app_id ${process.env.ADZUNA_APP_ID ? '✅' : '❌'} · app_key ${process.env.ADZUNA_APP_KEY ? '✅' : '❌'}`);
  lines.push(`Allowlist: ${ALLOWED_IDS.size} user(s)`);

  // Playwright chromium — the browser fallback for non-ATS URLs (LinkedIn etc.).
  try {
    const { chromium } = await import('playwright');
    const exe = chromium.executablePath();
    lines.push(`Chromium: ${fs.existsSync(exe) ? '✅ installed' : '❌ MISSING — run: npx playwright install chromium --with-deps'}`);
  } catch (e) {
    lines.push(`Chromium: ❌ playwright not loadable (${String(e.message).slice(0, 80)})`);
  }

  // Live ATS API reachability (the no-browser extraction path).
  if (typeof fetch === 'function') {
    try {
      const res = await fetch('https://api.ashbyhq.com/posting-api/job-board/ashby', { redirect: 'error' });
      lines.push(`Ashby API: ${res.ok ? '✅ reachable' : `⚠️ HTTP ${res.status}`}`);
    } catch (e) { lines.push(`Ashby API: ❌ ${String(e.message).slice(0, 60)}`); }
  }

  await bot.sendMessage(chatId, redactSecrets(lines.join('\n')));
}

// ---------------------------------------------------------------------------
// Router — allowlist gate first, then commands
// ---------------------------------------------------------------------------
function isAllowed(msg) {
  const fromId = String(msg.from?.id ?? '');
  const chatId = String(msg.chat?.id ?? '');
  // Private chats only, and the sender must be allowlisted.
  return msg.chat?.type === 'private' && ALLOWED_IDS.has(fromId) && fromId === chatId;
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  // Receipt log — makes "did the message even reach THIS process?" provable
  // from pm2 logs (duplicate pollers with the same token steal updates).
  console.log(`[recv] chat=${chatId} from=${msg.from?.id} ${msg.document ? `doc:${msg.document.file_name}` : `text:${(msg.text || '').slice(0, 80)}`}`);

  if (!isAllowed(msg)) {
    if (msg.chat?.type === 'private') {
      await bot.sendMessage(chatId,
        `🔒 This is a private family bot. Your Telegram id is \`${msg.from?.id}\` — ` +
        `ask the admin to add it to TELEGRAM_ALLOWED_IDS if you should have access.`,
        { parse_mode: 'Markdown' });
    }
    return;
  }

  try {
    // Resume uploads (documents) route to CV import.
    if (msg.document) return await handleDocument(chatId, msg.document);

    const text = (msg.text || '').trim();
    if (!text) return;

    if (text === '/start') return await handleStart(chatId);
    if (text === '/help') return await handleHelp(chatId);
    if (text === '/whoami') return await handleWhoami(chatId);
    if (text === '/diag') return await handleDiag(chatId);
    if (text === '/jobs') return await handleJobs(chatId);
    if (text === '/scan') return await handleScan(chatId);
    if (text === '/tailor') return await handleTailor(chatId);
    if (text === '/cover') return await handleCover(chatId);
    if (text === '/applykit') return await handleApplyKit(chatId);
    if (text === '/setcv') {
      const state = chatState.get(chatId) || {};
      state.awaitingCv = true;
      chatState.set(chatId, state);
      return await bot.sendMessage(chatId,
        '📎 Send your resume as a file (.pdf/.md/.txt), or paste the full text as your next message.');
    }
    if (text.startsWith('/status')) {
      return await handleStatus(chatId, text.replace('/status', '').trim() || null);
    }
    if (text.startsWith('/apply')) {
      return await handleApply(chatId, text.replace('/apply', '').trim());
    }
    if (text.startsWith('/')) {
      return await bot.sendMessage(chatId, '❓ Unknown command — /help lists everything.');
    }

    // CV paste mode takes the next long message.
    if (chatState.get(chatId)?.awaitingCv) return await handleCvPaste(chatId, text);

    // URLs → evaluate.
    const links = text.match(urlRegex);
    if (links?.length) return await evaluateJd(chatId, { url: cleanUrl(links[0]) });

    // Long plain text → treat as a pasted JD.
    if (text.length > 400) return await evaluateJd(chatId, { pastedText: text });

    await bot.sendMessage(chatId,
      'ℹ️ Send a job URL, paste a full JD, or use /help to see what I can do.');
  } catch (error) {
    console.error(`[${chatId}] router error:`, error);
    await bot.sendMessage(chatId, friendlyError(error));
  }
});

// ---------------------------------------------------------------------------
// Inline keyboard callbacks
// ---------------------------------------------------------------------------
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const fromId = String(query.from?.id ?? '');
  await bot.answerCallbackQuery(query.id);
  if (!ALLOWED_IDS.has(fromId)) return;

  try {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: query.message.message_id },
    );
  } catch { /* message too old to edit */ }

  if (query.data === 'tailor_yes') return handleTailor(chatId);
  if (query.data === 'tailor_force') return handleTailor(chatId, { force: true });
  if (query.data === 'tailor_skip') {
    await bot.sendMessage(chatId,
      '👍 Skipped — the evaluation is saved. /tailor works any time before your next evaluation.');
  }
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.code, error.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
