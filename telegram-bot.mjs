/**
 * telegram-bot.mjs
 * 
 * Telegram Bot wrapper for career-ops-agent.
 * Listens for LinkedIn URLs, extracts the JD, evaluates it via Gemini,
 * and replies with the results and tailored PDF.
 * 
 * Requires: npm install node-telegram-bot-api
 */

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execAsync = promisify(exec);

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
    console.error("❌ TELEGRAM_BOT_TOKEN missing in .env");
    process.exit(1);
}

// Ensure reports and output directories exist
const REPORTS_DIR = path.join(process.cwd(), 'reports');
const OUTPUT_DIR = path.join(process.cwd(), 'output');
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Polling mode
const bot = new TelegramBot(token, { polling: true });

console.log("🤖 Career-Ops Telegram Bot is online and listening...");

// Helper to get the most recently created file in a directory
function getLatestFile(dir) {
    const files = fs.readdirSync(dir)
        .filter(f => fs.statSync(path.join(dir, f)).isFile())
        .map(f => ({ file: f, time: fs.statSync(path.join(dir, f)).mtime.getTime() }))
        .sort((a, b) => b.time - a.time);
    return files.length > 0 ? path.join(dir, files[0].file) : null;
}

// URL Regex to detect links
const urlRegex = /(https?:\/\/[^\s]+)/g;

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || '';

    // Check if message contains a URL
    const links = text.match(urlRegex);
    
    if (links && links.length > 0) {
        const targetUrl = links[0];
        
        // Acknowledge the request
        await bot.sendMessage(chatId, `⏳ Received URL. Extracting job description using Playwright...\n🔗 ${targetUrl}`);
        
        try {
            // Step 1: Extract the JD using browser-extract
            await execAsync(`node browser-extract.mjs "${targetUrl}" > temp_jd.txt`);
            
            await bot.sendMessage(chatId, `✅ Extracted successfully. Now evaluating against your CV...`);

            // Step 2: Evaluate using gemini
            // (Using the provided script, outputting to a report)
            const { stdout: evalOutput } = await execAsync(`node gemini-eval.mjs --file temp_jd.txt`);
            
            // Extract the summary to send back to Telegram
            const summaryMatch = evalOutput.match(/---SCORE_SUMMARY---[\s\S]*?---END_SUMMARY---/);
            const summaryText = summaryMatch ? summaryMatch[0] : "Evaluation complete, but could not parse summary.";
            
            // Read the latest report for full details if needed
            const latestReport = getLatestFile(REPORTS_DIR);

            let replyMessage = `🎯 **Evaluation Complete** 🎯\n\n\`\`\`\n${summaryText}\n\`\`\`\n`;
            
            // Determine if we should generate a PDF based on the score
            // Parse score from summary text
            const scoreMatch = summaryText.match(/SCORE:\s*([0-9.]+)/);
            const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0;

            if (score >= 3.5) {
                replyMessage += `\nHigh match score detected (${score}/5). To generate a tailored PDF for this role, type:\n\`/pdf <company-slug>\``;
            } else {
                replyMessage += `\nLow match score (${score}/5). Filtering out. No PDF generated.`;
            }

            await bot.sendMessage(chatId, replyMessage, { parse_mode: 'Markdown' });

            // Note: If you want true 0-friction, you can trigger 'node generate-pdf.mjs' here automatically
            // and send the PDF back via bot.sendDocument(chatId, pdfFilePath).
            
        } catch (error) {
            console.error(error);
            const errMsg = error.message || '';
            
            // Distinguish quota/rate-limit errors from other failures
            if (errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('rate') || errMsg.includes('QUOTA_EXHAUSTED')) {
                await bot.sendMessage(chatId, 
                    `⚠️ **Rate Limit Hit**\n\n` +
                    `The Gemini API free-tier quota is temporarily exhausted.\n\n` +
                    `**What to do:**\n` +
                    `• Wait ~60 seconds and resend the URL\n` +
                    `• If this keeps happening, the daily quota may be used up (resets tomorrow)\n` +
                    `• Consider upgrading to a paid API key for higher limits`,
                    { parse_mode: 'Markdown' }
                );
            } else if (errMsg.includes('browser-extract') || errMsg.includes('playwright') || errMsg.includes('Navigation')) {
                await bot.sendMessage(chatId,
                    `❌ **Could not extract job description**\n\n` +
                    `The page might require login, be behind a paywall, or have unusual formatting.\n` +
                    `Try copying the JD text directly and sending it as a message instead.`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                await bot.sendMessage(chatId, 
                    `❌ **Error during processing**\n\n` +
                    `Something went wrong. Please try again in a moment.\n` +
                    `_If this persists, check the bot logs for details._`,
                    { parse_mode: 'Markdown' }
                );
            }
        }

    } else if (text.startsWith('/start')) {
        await bot.sendMessage(chatId, "👋 Welcome to your Career-Ops Mobile Agent.\n\nPaste any job URL (LinkedIn, Indeed, etc.) here and I will evaluate it against your profile.");
    }
});
