// tests/gemini-call.test.mjs — shared Gemini call path: daily-quota detection,
// model fallback, key redaction (no network).
//
// Guards the bug that let evaluation work while tailoring failed: the tailor's
// private isQuotaExhausted() tested for `limit: 0`, which Google never sends, so
// a daily-quota 429 was retried as if transient and no fallback ever ran.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { readFileSync } from 'fs';

console.log('\nGemini call path — lib/gemini-call.mjs');

// A real free-tier daily-quota 429 from @google/generative-ai (key redacted).
const DAILY_QUOTA_ERR = '[GoogleGenerativeAI Error]: Error fetching from '
  + 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent: '
  + '[429 Too Many Requests] You exceeded your current quota, please check your plan and billing details. '
  + '[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaMetric":'
  + '"generativelanguage.googleapis.com/generate_content_free_tier_requests","quotaId":'
  + '"GenerateRequestsPerDayPerProjectPerModel-FreeTier","quotaValue":"20"}]}]';

const PER_MINUTE_ERR = '[GoogleGenerativeAI Error]: [429 Too Many Requests] Resource has been exhausted '
  + '(e.g. check quota). quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier". '
  + 'Please retry in 11.899172084s';

// Verbatim from a live call on 2026-07-23 — Google closed 2.5-* to new accounts
// and reports it as a bare "[404 ]" with no NOT_FOUND token to match on.
const RETIRED_MODEL_ERR = '[GoogleGenerativeAI Error]: Error fetching from '
  + 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent: '
  + '[404 ] This model models/gemini-2.5-flash is no longer available to new users. '
  + 'Please update your code to use a newer model.';

/** Model stub: fails with `errors[i]` on call i, then returns `text`. */
function stubModel(errors, text = 'OK') {
  let i = 0;
  return {
    calls: () => i,
    generateContent: async () => {
      const e = errors[i++];
      if (e) throw new Error(e);
      return { response: { text: () => text } };
    },
  };
}

const silent = { log() {}, warn() {}, error() {} };

try {
  const mod = await import(pathToFileURL(join(ROOT, 'lib', 'gemini-call.mjs')).href);
  const { isQuotaExhausted, parseRetryDelay, isFatalKeyError, isTransientRateLimit, modelChain,
    callModelWithRetry, generateWithFallback, createFallbackModel, FALLBACK_MODELS } = mod;

  // --- quota classification -------------------------------------------------
  if (isQuotaExhausted(DAILY_QUOTA_ERR)) pass('daily free-tier 429 detected as quota-exhausted');
  else fail('daily-quota 429 NOT detected — tailoring will retry an exhausted model instead of falling back');

  if (!isQuotaExhausted(PER_MINUTE_ERR)) pass('per-minute 429 is NOT treated as daily exhaustion (stays retryable)');
  else fail('per-minute 429 misread as daily exhaustion — burns the fallback chain on a transient blip');

  // The exact regression: Google reports the quota VALUE, never "limit: 0".
  if (!/limit:\s*0/i.test(DAILY_QUOTA_ERR)) pass('real quota error carries no "limit: 0" (the old broken test)');
  else fail('fixture no longer represents the real payload');

  if (parseRetryDelay(PER_MINUTE_ERR) === 11900) pass('server-suggested retry delay parsed (11.899s → 11900ms)');
  else fail(`parseRetryDelay = ${parseRetryDelay(PER_MINUTE_ERR)}`);

  if (isFatalKeyError('API key not valid. Please pass a valid API key.')) pass('bad-key error classified fatal');
  else fail('bad key must not be retried across models');

  // Every Gemini error embeds the request URL, which ends in ":generateContent"
  // — and "gene-RATE-Content" contains "rate". A substring test for "rate" made
  // every failure look like a rate limit and bought 3 pointless retries.
  if (!isTransientRateLimit('[404 ] models/x:generateContent is no longer available to new users'))
    pass('"generateContent" in the URL is not mistaken for a rate limit');
  else fail('substring "rate" in generateContent misclassified as a rate limit');

  if (isTransientRateLimit(PER_MINUTE_ERR)) pass('a genuine 429 is still classified transient');
  else fail('real rate limit no longer detected');

  // --- retry behavior -------------------------------------------------------
  const quotaModel = stubModel([DAILY_QUOTA_ERR]);
  try {
    await callModelWithRetry(quotaModel, 'p', { log: silent });
    fail('daily quota should throw, not return');
  } catch (e) {
    if (String(e.message).startsWith('QUOTA_EXHAUSTED:') && quotaModel.calls() === 1)
      pass('daily quota fails fast on the first attempt (no wasted retries)');
    else fail(`expected 1 call + QUOTA_EXHAUSTED, got ${quotaModel.calls()} call(s): ${e.message}`);
  }

  const keyModel = stubModel(['API key not valid. Please pass a valid API key.']);
  try {
    await callModelWithRetry(keyModel, 'p', { log: silent });
    fail('bad key should throw');
  } catch (e) {
    if (String(e.message).startsWith('FATAL_KEY:')) pass('bad key surfaces as FATAL_KEY');
    else fail(`expected FATAL_KEY, got ${e.message}`);
  }

  // --- secret redaction -----------------------------------------------------
  const SECRET = 'EXAMPLE-fake-secret-not-a-real-key-000';
  const leaky = stubModel([`boom with key=${SECRET} inside`, `boom with key=${SECRET} inside`, `boom with key=${SECRET} inside`]);
  try {
    await callModelWithRetry(leaky, 'p', { maxRetries: 1, apiKey: SECRET, log: silent });
    fail('expected throw');
  } catch (e) {
    if (!e.message.includes(SECRET) && e.message.includes('[REDACTED]')) pass('API key redacted from error messages');
    else fail('API key leaked into the error message (it reaches Telegram)');
  }

  // --- fallback chain -------------------------------------------------------
  if (modelChain('gemini-3.6-flash', ['gemini-2.5-flash', 'gemini-3.6-flash'])
    .join() === 'gemini-3.6-flash,gemini-2.5-flash') pass('modelChain puts primary first and dedupes');
  else fail(`modelChain = ${modelChain('gemini-3.6-flash', ['gemini-2.5-flash', 'gemini-3.6-flash'])}`);

  if (!FALLBACK_MODELS.some((m) => m.includes('-lite'))) pass('no "-lite" models in the default chain');
  else fail('a -lite fallback under-fills the structured report / CV');

  // Retired models silently ate two of the three fallback slots. models.list
  // still advertises them; only generateContent reveals the 404.
  const retired = FALLBACK_MODELS.filter((m) => m.startsWith('gemini-2.5'));
  if (retired.length === 0) pass('no gemini-2.5-* models in the chain (404 for accounts created after their sunset)');
  else fail(`retired models still in the fallback chain: ${retired.join(', ')}`);

  {
    // A model closed to new users must be skipped, not treated as a hard error.
    let n = 0;
    const genAI = { getGenerativeModel: () => (++n === 1 ? stubModel([RETIRED_MODEL_ERR]) : stubModel([], 'ok')) };
    const out = await generateWithFallback(genAI, { model: 'gemini-2.5-flash' }, 'p', { log: silent });
    if (out.text === 'ok') pass('"no longer available to new users" (bare 404) falls through to the next model');
    else fail('retired-model 404 did not trigger fallback');
  }

  {
    // Primary out of daily quota → second model answers.
    const used = [];
    const genAI = {
      getGenerativeModel: ({ model }) => {
        used.push(model);
        return used.length === 1 ? stubModel([DAILY_QUOTA_ERR]) : stubModel([], 'tailored');
      },
    };
    const out = await generateWithFallback(genAI, { model: 'gemini-3.6-flash' }, 'p', { log: silent });
    if (out.text === 'tailored' && out.usedModel === FALLBACK_MODELS[0])
      pass(`quota-exhausted primary falls back to ${out.usedModel} and returns content`);
    else fail(`fallback produced ${JSON.stringify(out)}`);
  }

  {
    // Every model exhausted → one honest QUOTA_EXHAUSTED the bot can explain.
    const genAI = { getGenerativeModel: () => stubModel([DAILY_QUOTA_ERR]) };
    try {
      await generateWithFallback(genAI, { model: 'gemini-3.6-flash' }, 'p', { log: silent });
      fail('all-exhausted should throw');
    } catch (e) {
      if (e.message.startsWith('QUOTA_EXHAUSTED: All models exhausted')) pass('all models exhausted → QUOTA_EXHAUSTED');
      else fail(`expected QUOTA_EXHAUSTED, got ${e.message}`);
    }
  }

  {
    // A retired/typo'd model id is skipped, not fatal.
    let n = 0;
    const genAI = {
      getGenerativeModel: () => (++n === 1
        ? stubModel(['[404 Not Found] models/gemini-9-flash is not found for API version v1beta'])
        : stubModel([], 'ok')),
    };
    const out = await generateWithFallback(genAI, { model: 'gemini-9-flash' }, 'p', { log: silent });
    if (out.text === 'ok') pass('unknown model id falls through to the next model');
    else fail('unknown model should not be fatal');
  }

  {
    // Observed live: the primary was out of daily quota AND the first fallback
    // answered "[503 ] high demand". That used to abort the whole run.
    const OVERLOADED = '[GoogleGenerativeAI Error]: Error fetching from '
      + 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent: '
      + '[503 ] This model is currently experiencing high demand. Please try again later.';
    let n = 0;
    const genAI = {
      getGenerativeModel: () => {
        n++;
        if (n === 1) return stubModel([DAILY_QUOTA_ERR]);
        if (n === 2) return stubModel([OVERLOADED, OVERLOADED, OVERLOADED]);
        return stubModel([], 'cv html');
      },
    };
    const out = await generateWithFallback(genAI, { model: 'gemini-3.6-flash' }, 'p', { maxRetries: 1, log: silent });
    if (out.text === 'cv html' && n === 3) pass('exhausted primary + overloaded fallback → third model completes the job');
    else fail(`chain stopped early (models tried: ${n}, text: ${out.text})`);
  }

  {
    // When every model is merely busy, do NOT claim the daily quota is gone —
    // that sends the user away for 24h over a transient spike.
    const genAI = { getGenerativeModel: () => stubModel(['[503 ] high demand', '[503 ] high demand']) };
    try {
      await generateWithFallback(genAI, { model: 'gemini-3.6-flash' }, 'p', { maxRetries: 1, log: silent });
      fail('all-busy should throw');
    } catch (e) {
      if (e.message.startsWith('MODELS_BUSY:')) pass('all models busy reports MODELS_BUSY, not a quota lie');
      else fail(`expected MODELS_BUSY, got ${e.message.slice(0, 80)}`);
    }
  }

  {
    // A bad key aborts immediately — trying 3 more models cannot help.
    let n = 0;
    const genAI = { getGenerativeModel: () => { n++; return stubModel(['API key not valid. Please pass a valid API key.']); } };
    try {
      await generateWithFallback(genAI, { model: 'gemini-3.6-flash' }, 'p', { log: silent });
      fail('bad key should throw');
    } catch (e) {
      if (n === 1 && e.message.startsWith('FATAL_KEY:')) pass('bad key aborts the chain after one model');
      else fail(`bad key tried ${n} model(s): ${e.message}`);
    }
  }

  {
    // createFallbackModel pins the model that worked (cover/email retry loops).
    const used = [];
    const genAI = {
      getGenerativeModel: ({ model }) => {
        used.push(model);
        return used.length === 1 ? stubModel([DAILY_QUOTA_ERR]) : stubModel([], '{"ok":1}');
      },
    };
    const m = createFallbackModel(genAI, { model: 'gemini-3.6-flash' }, { log: silent });
    await m.generateContent('p');
    const afterFirst = used.length;
    await m.generateContent('p');
    if (used.length === afterFirst + 1 && used[used.length - 1] === m.usedModel())
      pass('createFallbackModel pins the working model (no re-probing exhausted ones)');
    else fail(`model probes: ${used.join(', ')}`);
  }

  // --- drift guard ----------------------------------------------------------
  // The whole point of the shared module: no caller may grow a private copy.
  const callers = ['gemini-eval.mjs', 'gemini-tailor.mjs', 'gemini-cover.mjs', 'gemini-email.mjs'];
  const drifted = callers.filter((f) => {
    const src = readFileSync(join(ROOT, f), 'utf-8');
    return !src.includes("lib/gemini-call.mjs") || /function\s+isQuotaExhausted/.test(src);
  });
  if (drifted.length === 0) pass(`all ${callers.length} Gemini callers share lib/gemini-call.mjs`);
  else fail(`private quota/fallback logic in: ${drifted.join(', ')} — they will drift again`);
} catch (err) {
  fail(`gemini-call test crashed: ${err.message}`);
}
