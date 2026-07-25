// tests/telegram-format.test.mjs — message-formatting guards for the bot.
//
// These are SOURCE-level assertions (the bot needs a live token to run), each
// pinning a formatting rule that broke in production once and would break
// silently again — a mangled message still sends, so nothing errors.
import { pass, fail, ROOT } from './helpers.mjs';
import { readFileSync } from 'fs';
import { join } from 'path';

console.log('\nTelegram message formatting — telegram-bot.mjs');

try {
  const src = readFileSync(join(ROOT, 'telegram-bot.mjs'), 'utf-8');

  /** Strip line comments so a guard tests CODE, not the prose explaining it. */
  const codeOnly = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  /** Body of a named async handler, up to the next top-level function. */
  const handler = (name) => {
    const start = src.indexOf(`async function ${name}(`);
    if (start === -1) return '';
    const rest = src.slice(start + 10);
    const end = rest.indexOf('\nasync function ');
    return rest.slice(0, end === -1 ? undefined : end);
  };

  // --- /jobs must not render URLs through Markdown -------------------------
  // Telegram's legacy Markdown reads `_…_` as italics and CONSUMES the
  // underscores, so an Adzuna link (?se=_qT4…&utm_medium=…&utm_source=…) was
  // DISPLAYED with them missing. Users copied that broken link back and JD
  // extraction failed. With several such links in one page the underscores pair
  // up across the message, so Telegram raises no error and sendMd()'s plain-text
  // fallback never fires — the message just silently arrives corrupted.
  const jobs = handler('handleJobs');
  if (jobs) pass('found handleJobs to inspect');
  else fail('could not locate handleJobs — update this guard');

  if (jobs && /\$\{url\}/.test(jobs)) pass('handleJobs interpolates job URLs (guard is looking at the right code)');
  else fail('handleJobs no longer interpolates ${url} — re-point this guard');

  const jobsSend = jobs.match(/await\s+(bot\.sendMessage|sendMd)\(chatId,\s*msg/);
  if (jobsSend && jobsSend[1] === 'bot.sendMessage')
    pass('/jobs sends its URL list as PLAIN TEXT (underscores survive)');
  else fail(`/jobs sends via ${jobsSend?.[1] || 'an unrecognized call'} — Markdown will eat underscores in job URLs`);

  if (jobs && !/parse_mode\s*:/.test(codeOnly(jobs))) pass('/jobs sets no parse_mode at all');
  else fail('/jobs still passes a parse_mode');

  // Bare URLs auto-link in Telegram, so plain text costs nothing — but the
  // preview must stay off or 8 links would each try to unfurl.
  if (/disable_web_page_preview:\s*true/.test(jobs)) pass('/jobs keeps link previews disabled');
  else fail('/jobs should disable web page previews');

  // --- the digest has the same exposure ------------------------------------
  // renderDigest() output carries job URLs and is sent with no parse_mode.
  const digestSend = /renderDigest\(([^)]*)\)[\s\S]{0,400}?disable_web_page_preview/.test(src);
  if (digestSend) pass('digest messages also disable previews');
  else fail('digest send path changed — re-check it does not use Markdown');

  const digestCall = src.match(/sendMessage\(\s*chatId,\s*renderDigest[\s\S]{0,200}?\)/);
  if (!digestCall || !/parse_mode/.test(digestCall[0]))
    pass('digest is sent without parse_mode (job URLs stay intact)');
  else fail('digest now uses parse_mode — URLs will be mangled');

  // --- sendMd must still exist as the fallback for prose messages ----------
  if (/function sendMd\(/.test(src) && /parse entities|can't find end/.test(src))
    pass('sendMd() still degrades Markdown-hostile prose to plain text');
  else fail('sendMd() or its entity-error fallback is gone');

  // --- code-fenced blocks are safe, and should stay fenced -----------------
  // Underscores are literal inside ``` in Telegram, which is why the ATS prefill
  // messages may keep Markdown. If a fence is ever dropped, that becomes unsafe.
  const fenced = (src.match(/\\`\\`\\`/g) || []).length;
  if (fenced >= 2) pass('ATS prefill output stays inside code fences (underscores literal there)');
  else fail('code fences around prefill output appear to have been removed');
} catch (err) {
  fail(`telegram-format test crashed: ${err.message}`);
}
