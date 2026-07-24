/**
 * lib/gemini-call.mjs — one shared Gemini call path: retry, daily-quota
 * detection, and model fallback.
 *
 * Why this exists: gemini-eval.mjs, gemini-tailor.mjs, gemini-cover.mjs and
 * gemini-email.mjs each grew their own copy of this logic, and the copies
 * drifted. Eval's copy was fixed to detect a per-DAY free-tier 429; the tailor's
 * copy still tested for `limit: 0`, which Google never sends (it reports the
 * quota VALUE, e.g. "quotaValue":"20"). The tailor therefore treated a daily
 * quota hit as a transient rate limit, burned three retries on the SAME
 * exhausted model, and exited without ever trying a fallback — so evaluation
 * worked while tailoring failed with "Daily AI quota used up". Cover letters and
 * outreach emails had no fallback at all.
 *
 * Every Gemini caller now imports from here, so a fix lands once for all of
 * them. See tests/gemini-call.test.mjs for the regression guards.
 */

/**
 * Models to fall back to, in order. Each has its OWN free-tier daily pool, so
 * exhausting one says nothing about the next.
 *
 * Verified against a live free-tier key on 2026-07-23 by POSTing a 1-token
 * generateContent to each candidate — models.list is NOT proof of usability:
 * it still advertises gemini-2.5-flash and gemini-2.5-flash-lite, but both
 * answer "404 … no longer available to new users". They used to head this
 * chain, which burned two of the three fallback slots on dead models.
 *
 * Deliberately NO "-lite" models: they under-fill the structured evaluation
 * report (the "missing Block A…G" validation failures) and produce thin CVs.
 * A caller that wants a different chain passes `fallbacks`.
 */
export const FALLBACK_MODELS = [
  'gemini-3.5-flash',        // previous workhorse, own daily pool
  'gemini-3-flash-preview',  // own daily pool
  'gemini-2.0-flash',        // large free tier, own daily pool
];

/** Sleep helper. */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Server-suggested retry delay, in ms, from a 429 body
 * ("Please retry in 11.899172084s"), or null when absent.
 *
 * @param {string} errorMsg
 * @returns {number|null}
 */
export function parseRetryDelay(errorMsg) {
  const match = String(errorMsg).match(/retry in ([0-9.]+)s/i);
  return match ? Math.ceil(parseFloat(match[1]) * 1000) : null;
}

/**
 * True when the error is a per-DAY free-tier quota hit, as opposed to a
 * transient per-minute 429.
 *
 * Match on the quota KIND, never on its value: a real response carries
 * `"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"` and
 * `"quotaValue":"20"` — testing for `limit: 0` silently never fires.
 * Retrying the same model cannot help; a model with its own pool can.
 *
 * @param {string} errorMsg
 * @returns {boolean}
 */
export function isQuotaExhausted(errorMsg) {
  const s = String(errorMsg);
  return /429|RESOURCE_EXHAUSTED|quota/i.test(s)
    && /per\s*day|perday|GenerateRequestsPerDay|free_tier_requests/i.test(s);
}

/**
 * True for errors that no retry and no other model can fix — a bad, revoked, or
 * unauthorized API key. Model-not-found is NOT here: switching models is
 * exactly the cure for a retired model id.
 *
 * @param {string} errorMsg
 * @returns {boolean}
 */
export function isFatalKeyError(errorMsg) {
  return /API_KEY|API key not valid|PERMISSION_DENIED|UNAUTHENTICATED/i.test(String(errorMsg));
}

/**
 * True when this model id is unusable but others may work — retired, typo'd, or
 * closed to new accounts ("no longer available to new users", which Google
 * returns as a bare `[404 ]` with no NOT_FOUND token anywhere in the message).
 */
function isModelUnavailable(errorMsg) {
  return /\[404|NOT_FOUND|is not found for API version|no longer available|not supported for generateContent/i
    .test(String(errorMsg));
}

/**
 * True for a retryable rate limit.
 *
 * Must be anchored: the old test was `msg.includes('rate')`, and every Gemini
 * error embeds the request URL — which ends in `:generateContent`, containing
 * the substring "rate". Every error therefore looked transient and got three
 * pointless retries with backoff before failing.
 *
 * @param {string} errorMsg
 * @returns {boolean}
 */
export function isTransientRateLimit(errorMsg) {
  return /\b429\b|RESOURCE_EXHAUSTED|rate.?limit|too many requests/i.test(String(errorMsg));
}

/**
 * True when the model itself is temporarily overloaded — Google's "[503 ] This
 * model is currently experiencing high demand" and friends. Retrying the same
 * model rarely clears a demand spike within seconds; another model usually
 * answers immediately, so this hands off down the chain.
 *
 * @param {string} errorMsg
 * @returns {boolean}
 */
export function isServiceOverloaded(errorMsg) {
  return /\b(?:500|502|503)\b|UNAVAILABLE|overloaded|high demand|internal error/i.test(String(errorMsg));
}

/** Replace the API key with [REDACTED] so no log or Telegram reply leaks it. */
function redactKey(msg, key) {
  const s = String(msg ?? '');
  return key ? s.split(key).join('[REDACTED]') : s;
}

/**
 * Call one model with backoff on transient rate limits.
 *
 * Throws with a prefix the caller dispatches on: `QUOTA_EXHAUSTED: ` (daily
 * quota gone), `FATAL_KEY: ` (bad key — nothing can help), `MODEL_UNAVAILABLE: `
 * (retired model id), `MODEL_BUSY: ` (rate limited or overloaded after every
 * retry). All but FATAL_KEY mean "try the next model".
 *
 * @param {object} model - A model handle from genAI.getGenerativeModel().
 * @param {any} contents - Prompt parts accepted by generateContent().
 * @param {{maxRetries?: number, apiKey?: string, log?: Console}} [opts]
 * @returns {Promise<string>} The model's text response.
 */
export async function callModelWithRetry(model, contents, opts = {}) {
  const { maxRetries = 3, apiKey = '', log = console } = opts;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await model.generateContent(contents);
      return result.response.text();
    } catch (err) {
      const msg = String(err?.message || err || '');
      const safe = redactKey(msg, apiKey);

      if (isFatalKeyError(msg)) throw new Error(`FATAL_KEY: ${safe}`);
      if (isModelUnavailable(msg)) throw new Error(`MODEL_UNAVAILABLE: ${safe}`);
      // Checked BEFORE the generic 429 branch: a daily hit is also a 429, and
      // retrying the same exhausted model just wastes 3 attempts and ~30s.
      if (isQuotaExhausted(msg)) throw new Error(`QUOTA_EXHAUSTED: ${safe}`);

      const rateLimited = isTransientRateLimit(msg);
      const overloaded = isServiceOverloaded(msg);
      if (attempt === maxRetries) {
        // MODEL_BUSY marks "this model, right now" — the caller moves to the
        // next model in the chain instead of failing the user's request. A 503
        // demand spike on one model does not mean the others are down.
        const prefix = (rateLimited || overloaded) ? 'MODEL_BUSY: ' : '';
        throw new Error(`${prefix}Gemini API error after ${maxRetries} attempts: ${safe}`);
      }
      const backoff = rateLimited
        ? (parseRetryDelay(msg) || Math.min(2000 * 2 ** (attempt - 1), 30_000))
        : 2000 * 2 ** (attempt - 1);
      const kind = rateLimited ? 'rate limited' : overloaded ? 'model overloaded' : 'transient';
      log.warn(`⚠️   Attempt ${attempt}/${maxRetries} failed (${kind}). Retrying in ${(backoff / 1000).toFixed(1)}s...`);
      await sleep(backoff);
    }
  }
  // Unreachable: the loop either returns or throws on the last attempt.
  throw new Error('Gemini API error: retry loop exhausted');
}

/**
 * Ordered model chain: the primary first, then the fallbacks, deduped.
 *
 * @param {string} primary
 * @param {string[]} [fallbacks=FALLBACK_MODELS]
 * @returns {string[]}
 */
export function modelChain(primary, fallbacks = FALLBACK_MODELS) {
  return [...new Set([primary, ...fallbacks].filter(Boolean))];
}

/**
 * Generate text, walking the model chain when a model's daily quota is gone or
 * the model id no longer exists.
 *
 * @param {object} genAI - GoogleGenerativeAI instance.
 * @param {{model: string, generationConfig?: object, fallbacks?: string[]}} config
 * @param {any} contents - Prompt parts.
 * @param {{maxRetries?: number, apiKey?: string, log?: Console}} [opts]
 * @returns {Promise<{text: string, usedModel: string}>}
 * @throws {Error} `QUOTA_EXHAUSTED: All models exhausted…` when every model in
 *   the chain is out of daily quota; `FATAL_KEY: …` for a bad key.
 */
export async function generateWithFallback(genAI, config, contents, opts = {}) {
  const { model: primary, generationConfig, fallbacks = FALLBACK_MODELS } = config;
  const { log = console } = opts;
  const chain = modelChain(primary, fallbacks);
  const reasons = [];
  let sawQuota = false;

  for (const [i, modelId] of chain.entries()) {
    if (i > 0) log.log(`🔄  Trying fallback model: ${modelId}...`);
    try {
      const model = genAI.getGenerativeModel({ model: modelId, generationConfig });
      const text = await callModelWithRetry(model, contents, opts);
      if (i > 0) log.log(`✅  Fallback to ${modelId} succeeded.`);
      return { text, usedModel: modelId };
    } catch (err) {
      const msg = String(err?.message || err || '');
      if (msg.startsWith('FATAL_KEY:')) throw err;   // no model can fix a bad key
      reasons.push(`${modelId}: ${msg.slice(0, 120)}`);
      if (msg.startsWith('QUOTA_EXHAUSTED:')) sawQuota = true;
      // Out of daily quota, retired, or overloaded → try the next model.
      // Anything else (a malformed prompt, a network failure) is a real error
      // that every model would hit identically: surface it, don't burn the chain.
      const recoverable = ['QUOTA_EXHAUSTED:', 'MODEL_UNAVAILABLE:', 'MODEL_BUSY:'].some((p) => msg.startsWith(p));
      log.warn(`⚠️   ${modelId} unavailable (${msg.startsWith('QUOTA_EXHAUSTED:') ? 'daily quota exhausted' : msg.replace(/^[A-Z_]+:\s*/, '').slice(0, 90)}).`);
      if (!recoverable) throw err;
    }
  }

  // Name the real reason: telling someone their daily quota is gone when every
  // model was merely overloaded sends them away for 24h over a 60-second blip.
  throw sawQuota
    ? new Error(`QUOTA_EXHAUSTED: All models exhausted (${chain.join(', ')}). ${reasons.join(' | ')}`)
    : new Error(`MODELS_BUSY: All models busy or unavailable (${chain.join(', ')}). ${reasons.join(' | ')}`);
}

/**
 * A model handle that transparently walks the fallback chain — a drop-in for
 * `genAI.getGenerativeModel(...)` in callers that own their own retry loop
 * (gemini-cover.mjs, gemini-email.mjs).
 *
 * Once a model succeeds it is pinned, so a multi-attempt caller does not
 * re-probe exhausted models on every attempt.
 *
 * @param {object} genAI - GoogleGenerativeAI instance.
 * @param {{model: string, generationConfig?: object, fallbacks?: string[]}} config
 * @param {{maxRetries?: number, apiKey?: string, log?: Console}} [opts]
 * @returns {{generateContent: (contents: any) => Promise<{response: {text: () => string}}>, usedModel: () => string}}
 */
export function createFallbackModel(genAI, config, opts = {}) {
  let pinned = null;
  return {
    async generateContent(contents) {
      const cfg = pinned ? { ...config, model: pinned, fallbacks: [] } : config;
      const { text, usedModel } = await generateWithFallback(genAI, cfg, contents, opts);
      pinned = usedModel;
      return { response: { text: () => text } };
    },
    usedModel: () => pinned || config.model,
  };
}
