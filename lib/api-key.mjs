/**
 * lib/api-key.mjs — normalize and sanity-check an API key pasted into chat.
 *
 * History: /setkey used to run `rawKey.replace(/[^A-Za-z0-9]/g, '')` on the
 * assumption that API keys are alphanumeric. Hunter and SerpApi keys are, but
 * Google's are not — an AI Studio key looks like `AQ.Ex4mpl3_…-abcdefgh` (older
 * ones like `AIzaSy…-_…`). Stripping "." and "_" silently produced a different
 * string, Google answered "API key not valid", and the bot reported a network
 * problem. Two perfectly good keys were rejected that way.
 *
 * So: never rewrite the key. Trim what chat clients add around it, then accept
 * or reject the whole thing.
 */

/** Charset every provider we support draws from (base64url + "." and "~+/="). */
const API_KEY_CHARSET = /^[A-Za-z0-9._~+/=-]+$/;

/**
 * Strip only the wrapping a pasted key picks up in chat — surrounding quotes,
 * backticks, angle brackets (users copy the `<key>` placeholder literally), and
 * whitespace. The key's own characters are never touched.
 *
 * @param {string} raw - Whatever followed `/setkey <service>`.
 * @returns {string} The key as the provider issued it.
 */
export function cleanKey(raw) {
  return String(raw || '')
    .trim()
    .replace(/^[<"'`\s]+/, '')
    .replace(/[>"'`\s]+$/, '')
    .trim();
}

/**
 * True when the string could be an API key: right charset, plausible length.
 *
 * Also the security gate — the charset excludes every shell metacharacter, so
 * even a caller that interpolates the key into a command line cannot be made to
 * run something else. (The bot itself passes it through execFile, no shell.)
 *
 * @param {string} key - Output of cleanKey().
 * @returns {boolean}
 */
export function isPlausibleApiKey(key) {
  const k = String(key || '');
  return k.length >= 20 && k.length <= 300 && API_KEY_CHARSET.test(k);
}
