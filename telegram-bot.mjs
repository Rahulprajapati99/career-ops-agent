/**
 * telegram-bot.mjs
 *
 * Full-pipeline Telegram Bot for career-ops-agent.
 * Listens for job URLs, evaluates JDs, offers resume tailoring (with user consent),
 * generates PDFs, tracks applications, and provides status queries.
 *
 * Commands:
 *   (send URL)     — Extract JD, evaluate, offer tailoring
 *   /start         — Welcome message
 *   /help          — List available commands
 *   /status        — Show all tracked applications
 *   /status <co>   — Filter by company name
 *   /tailor        — Tailor resume from last evaluation (if not done via button)
 *   /cover <num>   — Generate cover letter for report #NNN
 *   /apply <url>   — ATS prefill cheat-sheet
 *   /scan          — Discover new matching jobs
 *
 * Requires: npm install node-telegram-bot-api dotenv
 */

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Environment & setup
// ---------------------------------------------------------------------------
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('❌ TELEGRAM_BOT_TOKEN missing in .env');
  process.exit(1);
}

const CWD = process.cwd();
const REPORTS_DIR = path.join(CWD, 'reports');
const OUTPUT_DIR = path.join(CWD, 'output');
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const bot = new TelegramBot(token, { polling: true });

console.log('🤖 Career-Ops Telegram Bot is online and listening...');

// ---------------------------------------------------------------------------
// Per-chat state (stores last evaluation context for tailor/cover/apply)
// ---------------------------------------------------------------------------
const chatState = new Map();

// Maximum exec buffer (5MB) and timeouts
const EXEC_OPTS = { maxBuffer: 1024 * 1024 * 5, cwd: CWD };
const LONG_EXEC_OPTS = { ...EXEC_OPTS, timeout: 300_000 }; // 5 min for tailoring

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const urlRegex = /(https?:\/\/[^\s]+)/g;

function getLatestFile(dir, extension) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => {
      if (!fs.statSync(path.join(dir, f)).isFile()) return false;
      return extension ? f.endsWith(extension) : true;
    })
    .map(f => ({ file: f, time: fs.statSync(path.join(dir, f)).mtime.getTime() }))
    .sort((a, b) => b.time - a.time);
  return files.length > 0 ? path.join(dir, files[0].file) : null;
}

function escapeMarkdown(text) {
  // Escape Telegram MarkdownV2 special chars (but not inside code blocks)
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function parseScoreSummary(stdout) {
  const match = stdout.match(/---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/);
  if (!match) return null;

  const block = match[1];
  const extract = (key) => {
    const line = block.split('\n').find(l => l.trimStart().startsWith(`${key}:`));
    return line ? line.split(':').slice(1).join(':').trim() : 'unknown';
  };

  return {
    company:    extract('COMPANY'),
    role:       extract('ROLE'),
    score:      parseFloat(extract('SCORE')) || 0,
    archetype:  extract('ARCHETYPE'),
    legitimacy: extract('LEGITIMACY'),
    raw:        match[0],
  };
}

function parseReportPath(stdout) {
  const match = stdout.match(/Report saved:\s*(.+\.md)/);
  return match ? match[1].trim() : null;
}

function parseTailorHtmlPath(stdout) {
  const match = stdout.match(/HTML_PATH:\s*(.+)/);
  return match ? match[1].trim() : null;
}

// ---------------------------------------------------------------------------
// URL handler — Extract JD, evaluate, offer tailoring
// ---------------------------------------------------------------------------
async function handleUrl(chatId, url) {
  const jdFile = path.join(CWD, `temp_jd_${chatId}.txt`);

  await bot.sendMessage(chatId,
    `⏳ Received URL. Extracting job description...\n🔗 ${url}`
  );

  try {
    // Step 1: Extract JD
    await execAsync(`node browser-extract.mjs "${url}" > "${jdFile}"`, LONG_EXEC_OPTS);
    await bot.sendMessage(chatId, '✅ Extracted successfully. Now evaluating against your CV...');

    // Step 2: Evaluate
    const { stdout: evalOutput } = await execAsync(
      `node gemini-eval.mjs --file "${jdFile}"`,
      LONG_EXEC_OPTS
    );

    // Step 3: Parse results
    const summary = parseScoreSummary(evalOutput);
    const reportRelPath = parseReportPath(evalOutput);
    const reportFullPath = reportRelPath
      ? path.join(CWD, reportRelPath)
      : getLatestFile(REPORTS_DIR, '.md');

    if (!summary) {
      await bot.sendMessage(chatId, '⚠️ Evaluation complete but could not parse summary. Check server logs.');
      return;
    }

    // Store state for this chat
    chatState.set(chatId, {
      jdFile,
      reportPath: reportFullPath,
      company: summary.company,
      role: summary.role,
      score: summary.score,
      archetype: summary.archetype,
      legitimacy: summary.legitimacy,
      tailored: false,
      timestamp: Date.now(),
    });

    // Step 4: Build reply with inline keyboard
    const scoreEmoji = summary.score >= 4 ? '🟢' : summary.score >= 3 ? '🟡' : '🔴';
    let replyText =
      `🎯 *Evaluation Complete* 🎯\n\n` +
      `🏢 *Company:* ${summary.company}\n` +
      `💼 *Role:* ${summary.role}\n` +
      `${scoreEmoji} *Score:* ${summary.score}/5\n` +
      `🎭 *Archetype:* ${summary.archetype}\n` +
      `🔒 *Legitimacy:* ${summary.legitimacy}\n\n` +
      `📊 Report saved & application tracked.`;

    // Inline keyboard — always ask before tailoring
    const keyboard = { reply_markup: { inline_keyboard: [] } };

    if (summary.score >= 3.5) {
      replyText += `\n\n✨ *High match detected!* Would you like me to tailor your resume for this role?`;
      keyboard.reply_markup.inline_keyboard.push([
        { text: '📄 Yes, Tailor My Resume', callback_data: 'tailor_yes' },
        { text: '❌ Skip', callback_data: 'tailor_skip' },
      ]);
    } else {
      replyText += `\n\n📉 Low match score. Filtered out.`;
      keyboard.reply_markup.inline_keyboard.push([
        { text: '📄 Tailor Anyway', callback_data: 'tailor_yes' },
        { text: '❌ Skip', callback_data: 'tailor_skip' },
      ]);
    }

    await bot.sendMessage(chatId, replyText, { parse_mode: 'Markdown', ...keyboard });

  } catch (error) {
    console.error(error);
    const errMsg = error.message || '';

    if (errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('rate') || errMsg.includes('QUOTA_EXHAUSTED')) {
      await bot.sendMessage(chatId,
        `⚠️ *Rate Limit Hit*\n\n` +
        `The Gemini API free-tier quota is temporarily exhausted.\n\n` +
        `*What to do:*\n` +
        `• Wait ~60 seconds and resend the URL\n` +
        `• If this keeps happening, the daily quota may be used up (resets tomorrow)\n` +
        `• Consider upgrading to a paid API key for higher limits`,
        { parse_mode: 'Markdown' }
      );
    } else if (errMsg.includes('browser-extract') || errMsg.includes('playwright') || errMsg.includes('Navigation')) {
      await bot.sendMessage(chatId,
        `❌ *Could not extract job description*\n\n` +
        `The page might require login, be behind a paywall, or have unusual formatting.\n` +
        `Try copying the JD text directly and sending it as a message instead.`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await bot.sendMessage(chatId,
        `❌ *Error during processing*\n\n` +
        `Something went wrong. Please try again in a moment.\n` +
        `_If this persists, check the bot logs for details._`,
        { parse_mode: 'Markdown' }
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Tailor handler — Generate tailored CV + PDF
// ---------------------------------------------------------------------------
async function handleTailor(chatId) {
  const state = chatState.get(chatId);

  if (!state || !state.jdFile || !state.reportPath) {
    await bot.sendMessage(chatId, '❌ No recent evaluation found. Send a job URL first.');
    return;
  }

  if (state.tailored) {
    await bot.sendMessage(chatId, '✅ Resume was already tailored for this evaluation. Send a new URL to evaluate another job.');
    return;
  }

  if (!fs.existsSync(state.jdFile)) {
    await bot.sendMessage(chatId, '❌ JD file no longer available. Please resend the job URL.');
    return;
  }

  if (!fs.existsSync(state.reportPath)) {
    await bot.sendMessage(chatId, '❌ Report file not found. Please resend the job URL.');
    return;
  }

  await bot.sendMessage(chatId,
    `⏳ Tailoring your resume for *${state.company}* — *${state.role}*...\n` +
    `This may take 30-90 seconds.`,
    { parse_mode: 'Markdown' }
  );

  try {
    // Step 1: Tailor the CV using Gemini
    const { stdout: tailorOutput } = await execAsync(
      `node gemini-tailor.mjs --jd "${state.jdFile}" --report "${state.reportPath}"`,
      LONG_EXEC_OPTS
    );

    const htmlPath = parseTailorHtmlPath(tailorOutput);
    if (!htmlPath || !fs.existsSync(htmlPath)) {
      await bot.sendMessage(chatId, '❌ Tailoring completed but could not find the output HTML file.');
      return;
    }

    await bot.sendMessage(chatId, '✅ CV tailored. Generating PDF...');

    // Step 2: Generate PDF from tailored HTML
    const pdfPath = htmlPath.replace(/\.html$/, '.pdf');
    await execAsync(
      `node generate-pdf.mjs "${htmlPath}" "${pdfPath}"`,
      LONG_EXEC_OPTS
    );

    if (!fs.existsSync(pdfPath)) {
      // If PDF generation failed, send the HTML file as fallback
      await bot.sendMessage(chatId, '⚠️ PDF generation failed. Sending HTML version instead.');
      await bot.sendDocument(chatId, htmlPath, {
        caption: `📄 Tailored CV for ${state.company} — ${state.role}`,
      });
    } else {
      // Send the PDF
      await bot.sendDocument(chatId, pdfPath, {
        caption: `📄 Tailored CV for ${state.company} — ${state.role} (Score: ${state.score}/5)`,
      });
    }

    // Mark as tailored
    state.tailored = true;
    state.pdfPath = fs.existsSync(pdfPath) ? pdfPath : null;
    state.htmlPath = htmlPath;
    chatState.set(chatId, state);

    await bot.sendMessage(chatId,
      `✅ *Resume tailored and delivered!*\n\n` +
      `Next steps:\n` +
      `• /cover — Generate a cover letter\n` +
      `• /apply <url> — Get ATS prefill guide\n` +
      `• /status — View all tracked applications`,
      { parse_mode: 'Markdown' }
    );

  } catch (error) {
    console.error('Tailor error:', error);
    const errMsg = error.message || '';

    if (errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('QUOTA_EXHAUSTED')) {
      await bot.sendMessage(chatId,
        `⚠️ *Rate Limit Hit during tailoring*\n\n` +
        `The Gemini API quota is temporarily exhausted.\n` +
        `Wait a moment and type /tailor to retry.`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await bot.sendMessage(chatId,
        `❌ *Tailoring failed*\n\n` +
        `Something went wrong. Type /tailor to retry.\n` +
        `_If this persists, check the bot logs._`,
        { parse_mode: 'Markdown' }
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------
async function handleStart(chatId) {
  await bot.sendMessage(chatId,
    `👋 *Welcome to Career-Ops Mobile Agent*\n\n` +
    `I'm your AI-powered job search assistant. Here's what I can do:\n\n` +
    `📋 *Paste any job URL* — I'll evaluate it against your profile\n` +
    `📄 *Tailor your resume* — I'll customize your CV for the role\n` +
    `📊 *Track applications* — I keep a record of every evaluation\n\n` +
    `Type /help to see all available commands.`,
    { parse_mode: 'Markdown' }
  );
}

async function handleHelp(chatId) {
  await bot.sendMessage(chatId,
    `📖 *Available Commands*\n\n` +
    `🔗 *Send a job URL* — Evaluate any job posting\n\n` +
    `*Evaluation & Resume:*\n` +
    `/tailor — Tailor resume from last evaluation\n` +
    `/cover — Generate cover letter (last eval)\n` +
    `/apply <url> — ATS prefill cheat-sheet\n\n` +
    `*Tracking & Discovery:*\n` +
    `/status — View all tracked applications\n` +
    `/status <company> — Filter by company\n` +
    `/scan — Discover new matching jobs\n\n` +
    `*General:*\n` +
    `/help — Show this message\n` +
    `/start — Welcome message`,
    { parse_mode: 'Markdown' }
  );
}

async function handleStatus(chatId, companyFilter) {
  try {
    const cmd = companyFilter
      ? `node tracker.mjs query --company "${companyFilter}" --json --limit 20`
      : `node tracker.mjs query --json --limit 20`;

    const { stdout } = await execAsync(cmd, EXEC_OPTS);

    // Try to parse JSON output
    let rows;
    try {
      rows = JSON.parse(stdout);
    } catch {
      // If JSON parsing fails, just send raw output
      const trimmed = stdout.trim();
      if (!trimmed || trimmed === '[]') {
        await bot.sendMessage(chatId, '📊 No tracked applications found yet. Send a job URL to get started!');
      } else {
        await bot.sendMessage(chatId, `📊 *Applications Tracker*\n\n\`\`\`\n${trimmed.slice(0, 3500)}\n\`\`\``, { parse_mode: 'Markdown' });
      }
      return;
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      await bot.sendMessage(chatId,
        companyFilter
          ? `📊 No applications found for "${companyFilter}".`
          : '📊 No tracked applications found yet. Send a job URL to get started!'
      );
      return;
    }

    // Format as a readable list
    let msg = companyFilter
      ? `📊 *Applications for "${companyFilter}":*\n\n`
      : `📊 *Recent Applications (${rows.length}):*\n\n`;

    for (const row of rows.slice(0, 15)) { // cap at 15 to avoid Telegram message limit
      const scoreEmoji = (row.score || 0) >= 4 ? '🟢' : (row.score || 0) >= 3 ? '🟡' : '🔴';
      msg += `${scoreEmoji} *${row.company || '?'}* — ${row.role || '?'}\n`;
      msg += `   Score: ${row.score || '?'}/5 | Status: ${row.status || '?'} | ${row.date || ''}\n\n`;
    }

    if (rows.length > 15) {
      msg += `_...and ${rows.length - 15} more_\n`;
    }

    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });

  } catch (error) {
    console.error('Status error:', error);

    // Tracker might not be synced yet — try a simpler approach
    const trackerPath = path.join(CWD, 'data', 'applications.md');
    if (fs.existsSync(trackerPath)) {
      const content = fs.readFileSync(trackerPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.startsWith('|') && !l.includes('---'));
      if (lines.length > 1) {
        const recent = lines.slice(Math.max(1, lines.length - 10)).join('\n');
        await bot.sendMessage(chatId,
          `📊 *Recent Applications:*\n\n\`\`\`\n${recent.slice(0, 3500)}\n\`\`\``,
          { parse_mode: 'Markdown' }
        );
        return;
      }
    }

    await bot.sendMessage(chatId, '📊 No tracked applications found yet. Send a job URL to get started!');
  }
}

async function handleCover(chatId) {
  const state = chatState.get(chatId);

  if (!state || !state.reportPath) {
    await bot.sendMessage(chatId, '❌ No recent evaluation found. Send a job URL and evaluate it first.');
    return;
  }

  await bot.sendMessage(chatId,
    `⏳ Generating cover letter for *${state.company}* — *${state.role}*...\nThis may take 30-60 seconds.`,
    { parse_mode: 'Markdown' }
  );

  try {
    // Generate cover letter JSON payload using Gemini, then render
    // For now, use a simplified approach: call gemini-tailor with cover-letter mode
    const { stdout } = await execAsync(
      `node generate-cover-letter.mjs --payload "${state.reportPath}"`,
      LONG_EXEC_OPTS
    );

    // Look for generated PDF in output/
    const coverPdf = getLatestFile(OUTPUT_DIR, '-cover.pdf');
    if (coverPdf && fs.existsSync(coverPdf)) {
      await bot.sendDocument(chatId, coverPdf, {
        caption: `📄 Cover letter for ${state.company} — ${state.role}`,
      });
    } else {
      await bot.sendMessage(chatId,
        `⚠️ Cover letter generation is not fully configured yet.\n` +
        `The cover letter script requires a JSON payload. ` +
        `Use the CLI directly:\n\n` +
        `\`node generate-cover-letter.mjs --payload cover.json\``,
        { parse_mode: 'Markdown' }
      );
    }
  } catch (error) {
    console.error('Cover letter error:', error);
    await bot.sendMessage(chatId,
      `⚠️ Cover letter generation requires additional setup.\n` +
      `Use the CLI directly:\n` +
      `\`node generate-cover-letter.mjs --help\``,
      { parse_mode: 'Markdown' }
    );
  }
}

async function handleApply(chatId, applyUrl) {
  const state = chatState.get(chatId);

  if (!applyUrl) {
    await bot.sendMessage(chatId, '❌ Usage: /apply <application-url>\n\nExample: /apply https://boards.greenhouse.io/company/jobs/12345');
    return;
  }

  const pdfPath = state?.pdfPath || getLatestFile(OUTPUT_DIR, '.pdf');

  if (!pdfPath || !fs.existsSync(pdfPath)) {
    await bot.sendMessage(chatId, '⚠️ No tailored PDF found. Tailor your resume first, then run /apply.');
    return;
  }

  await bot.sendMessage(chatId, '⏳ Generating ATS prefill cheat-sheet...');

  try {
    const { stdout } = await execAsync(
      `node prepare-application.mjs --url "${applyUrl}" --pdf "${pdfPath}"`,
      EXEC_OPTS
    );

    const output = stdout.trim();
    if (output) {
      await bot.sendMessage(chatId,
        `📋 *ATS Prefill Guide*\n\n\`\`\`\n${output.slice(0, 3500)}\n\`\`\``,
        { parse_mode: 'Markdown' }
      );
    } else {
      await bot.sendMessage(chatId, '⚠️ Could not generate prefill guide for this URL. The ATS might not be supported.');
    }
  } catch (error) {
    console.error('Apply error:', error);
    await bot.sendMessage(chatId,
      `⚠️ Could not generate prefill guide.\n` +
      `Supported ATS: Greenhouse, Ashby, Lever.\n` +
      `Make sure the URL is a direct application link.`,
      { parse_mode: 'Markdown' }
    );
  }
}

async function handleScan(chatId) {
  await bot.sendMessage(chatId, '⏳ Scanning ATS portals for new matching jobs... This may take 2-5 minutes.');

  try {
    const { stdout } = await execAsync(
      'node scan-ats-full.mjs --since 3 --json --limit 20',
      { ...EXEC_OPTS, timeout: 600_000 } // 10 min timeout for scanning
    );

    let results;
    try {
      results = JSON.parse(stdout);
    } catch {
      const trimmed = stdout.trim();
      if (trimmed) {
        await bot.sendMessage(chatId, `🔍 *Scan Results:*\n\n${trimmed.slice(0, 3500)}`, { parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(chatId, '🔍 Scan complete. No new matching jobs found in the last 3 days.');
      }
      return;
    }

    if (!Array.isArray(results) || results.length === 0) {
      await bot.sendMessage(chatId, '🔍 Scan complete. No new matching jobs found in the last 3 days.');
      return;
    }

    let msg = `🔍 *Found ${results.length} new matching jobs:*\n\n`;
    for (const job of results.slice(0, 10)) {
      msg += `🏢 *${job.company || '?'}*\n`;
      msg += `   ${job.title || job.role || '?'}\n`;
      if (job.url) msg += `   🔗 ${job.url}\n`;
      msg += '\n';
    }

    if (results.length > 10) {
      msg += `_...and ${results.length - 10} more. Check data/pipeline.md for full results._`;
    }

    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });

  } catch (error) {
    console.error('Scan error:', error);
    await bot.sendMessage(chatId,
      '❌ Scan failed. Make sure `portals.yml` is configured and Playwright is installed.'
    );
  }
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  // Ignore empty messages or non-text
  if (!text) return;

  // Route commands
  if (text === '/start') return handleStart(chatId);
  if (text === '/help') return handleHelp(chatId);
  if (text === '/tailor') return handleTailor(chatId);
  if (text === '/cover') return handleCover(chatId);
  if (text === '/scan') return handleScan(chatId);

  if (text.startsWith('/status')) {
    const company = text.replace('/status', '').trim();
    return handleStatus(chatId, company || null);
  }

  if (text.startsWith('/apply')) {
    const applyUrl = text.replace('/apply', '').trim();
    return handleApply(chatId, applyUrl);
  }

  // Check for URLs
  const links = text.match(urlRegex);
  if (links && links.length > 0) {
    return handleUrl(chatId, links[0]);
  }

  // Unknown input — show help hint
  if (text.startsWith('/')) {
    await bot.sendMessage(chatId, '❓ Unknown command. Type /help to see available commands.');
  }
});

// ---------------------------------------------------------------------------
// Callback query handler (inline keyboard buttons)
// ---------------------------------------------------------------------------
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  // Acknowledge the button press immediately
  await bot.answerCallbackQuery(query.id);

  if (data === 'tailor_yes') {
    // Remove the inline keyboard from the original message
    try {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: chatId, message_id: query.message.message_id }
      );
    } catch { /* ignore if message is too old to edit */ }

    return handleTailor(chatId);

  } else if (data === 'tailor_skip') {
    // Remove the inline keyboard and confirm skip
    try {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: chatId, message_id: query.message.message_id }
      );
    } catch { /* ignore */ }

    await bot.sendMessage(chatId,
      '👍 Skipped. Your evaluation report is saved.\n\n' +
      'You can always type /tailor later to generate a tailored resume.'
    );
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
