#!/usr/bin/env node

/**
 * jd-fetch.mjs — Family Edition: fetch a job description by URL, API-first.
 *
 * ATS job pages (Ashby, Greenhouse, Lever) are JS-heavy SPAs that need a full
 * browser to scrape — yet all three expose public zero-auth APIs that return
 * the same JD as clean JSON. This fetcher recognizes those URLs and takes the
 * API path (fast, no Playwright, works on headless VMs); anything else falls
 * back to browser-extract.mjs.
 *
 * Company-hosted careers pages that EMBED one of those boards
 * (`https://boomi.com/boomi-jobs/?gh_jid=5786913004`) are handled too: the job
 * id is in the URL but the board token is only in the page's embed script, so
 * `discoverEmbeddedBoard()` fetches the page once to resolve it, then takes the
 * same API path. Without this the browser fallback reads the marketing shell —
 * the real JD lives inside a cross-origin iframe — and hands a JD-less page to
 * the evaluator, which fails validation with "missing Block A…G".
 *
 * Usage:
 *   node jd-fetch.mjs <job-url>     # JD text on stdout; non-zero exit on failure
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeEntities } from './providers/_html-entities.mjs';
import { rejectPrivateOrInvalid } from './liveness-browser.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Convert JD HTML to readable plain text: block-level closers become line
 * breaks, list items become "- " bullets, then tags are stripped and entities
 * decoded. Exported for tests.
 */
export function htmlToText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/ul|\/ol)\s*\/?\s*>/gi, '\n')
      .replace(/<\s*li[^>]*>/gi, '\n- ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Recognize ATS job URLs that have a public API behind them.
 * Exported for tests.
 *
 * @param {string} url
 * @returns {{ kind: 'ashby'|'greenhouse'|'lever', org: string, id: string } | null}
 */
export function parseJobUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean);

  // Ashby: jobs.ashbyhq.com/{org}/{uuid}[/application]
  if (host === 'jobs.ashbyhq.com' && segs.length >= 2) {
    const id = segs.find((s) => UUID_RE.test(s));
    if (id) return { kind: 'ashby', org: segs[0], id };
  }

  // Greenhouse: (job-)boards(.eu).greenhouse.io/{org}/jobs/{id}  or  /{org}?gh_jid={id}
  if (/^(job-)?boards(\.eu)?\.greenhouse\.io$/.test(host) && segs.length >= 1) {
    const jobsIdx = segs.indexOf('jobs');
    if (jobsIdx > 0 && /^\d+$/.test(segs[jobsIdx + 1] || '')) {
      return { kind: 'greenhouse', org: segs[0], id: segs[jobsIdx + 1] };
    }
    const ghJid = u.searchParams.get('gh_jid');
    if (ghJid && /^\d+$/.test(ghJid)) return { kind: 'greenhouse', org: segs[0], id: ghJid };
  }

  // Lever: jobs(.eu).lever.co/{org}/{uuid}
  if (/^jobs(\.eu)?\.lever\.co$/.test(host) && segs.length >= 2 && UUID_RE.test(segs[1])) {
    return { kind: 'lever', org: segs[0], id: segs[1] };
  }

  return null;
}

/**
 * Recognize an ATS job id embedded in a company-hosted careers page — the
 * `?gh_jid=` / `?ashby_jid=` form that an embed script turns into a job board.
 * Only the KIND and ID come from the URL; the board token (org) lives in the
 * page markup, so this returns no org. Exported for tests.
 *
 * @param {string} url
 * @returns {{ kind: 'greenhouse'|'ashby', id: string } | null}
 */
export function parseEmbeddedJobUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  // A first-party ATS host is parseJobUrl's job — this path is for the embeds.
  if (parseJobUrl(url)) return null;

  const ghJid = u.searchParams.get('gh_jid');
  if (ghJid && /^\d+$/.test(ghJid)) return { kind: 'greenhouse', id: ghJid };

  const ashbyJid = u.searchParams.get('ashby_jid');
  if (ashbyJid && UUID_RE.test(ashbyJid)) return { kind: 'ashby', id: ashbyJid };

  return null;
}

/**
 * Pull the board token out of a company page's embed markup. Greenhouse embeds
 * load `boards.greenhouse.io/embed/job_board/js?for={token}`; Ashby embeds point
 * at `jobs.ashbyhq.com/{org}/embed`. Exported for tests.
 *
 * @param {string} html
 * @param {'greenhouse'|'ashby'} kind
 * @returns {string|null}
 */
export function findEmbeddedBoardToken(html, kind) {
  const s = String(html || '');
  const patterns = kind === 'greenhouse'
    ? [
      /greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([A-Za-z0-9_-]+)/i,
      /job-boards(?:\.eu)?\.greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([A-Za-z0-9_-]+)/i,
      /["']?board_?token["']?\s*[:=]\s*["']([A-Za-z0-9_-]+)["']/i,
      /(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/([A-Za-z0-9_-]+)/i,
    ]
    : [
      /jobs\.ashbyhq\.com\/([A-Za-z0-9._-]+)\/embed/i,
      /["']?ashby(?:_|-)?(?:job_?board|org)(?:_?name)?["']?\s*[:=]\s*["']([A-Za-z0-9._-]+)["']/i,
      /jobs\.ashbyhq\.com\/([A-Za-z0-9._-]+)/i,
    ];

  for (const re of patterns) {
    const m = s.match(re);
    // "embed" as the captured org means the pattern matched its own path segment.
    if (m?.[1] && m[1].toLowerCase() !== 'embed') return m[1];
  }
  return null;
}

/**
 * Fetch a page's HTML, SSRF-guarded on both the requested and the final URL
 * (a company careers page legitimately redirects, so redirects are followed —
 * but never into private space).
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchHtml(url) {
  const guard = rejectPrivateOrInvalid(url);
  if (guard) throw new Error(guard.reason);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: controller.signal,
    });
    const finalGuard = rejectPrivateOrInvalid(res.url || url);
    if (finalGuard) throw new Error(`redirected to a blocked host: ${finalGuard.reason}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a company-hosted embed URL to the ATS coordinates its API needs.
 * Returns the same shape as parseJobUrl, so the API path is shared.
 *
 * @param {string} url
 * @returns {Promise<{ kind: 'greenhouse'|'ashby', org: string, id: string } | null>}
 */
export async function discoverEmbeddedBoard(url) {
  const hint = parseEmbeddedJobUrl(url);
  if (!hint) return null;
  const org = findEmbeddedBoardToken(await fetchHtml(url), hint.kind);
  return org ? { kind: hint.kind, org, id: hint.id } : null;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; career-ops/1.3)', accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** API-path fetch. Returns { title, company, location, description } or null. */
export async function fetchViaApi(parsed) {
  const { kind, org, id } = parsed;

  if (kind === 'ashby') {
    const json = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}`);
    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
    const job = jobs.find((j) => j?.id === id || String(j?.jobUrl || '').includes(id));
    if (!job) return null;
    const desc = job.descriptionHtml || job.descriptionPlain || '';
    if (!desc) return null;
    return {
      title: job.title || '',
      company: job.organizationName || org,
      location: job.location || '',
      description: htmlToText(desc),
    };
  }

  if (kind === 'greenhouse') {
    const json = await fetchJson(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(org)}/jobs/${encodeURIComponent(id)}`,
    );
    if (!json?.content) return null;
    // Greenhouse returns HTML-escaped HTML — decode once, then flatten.
    return {
      title: json.title || '',
      company: json.company_name || org,
      location: json.location?.name || '',
      description: htmlToText(decodeEntities(json.content)),
    };
  }

  if (kind === 'lever') {
    const json = await fetchJson(
      `https://api.lever.co/v0/postings/${encodeURIComponent(org)}/${encodeURIComponent(id)}`,
    );
    if (!json?.text && !json?.descriptionPlain) return null;
    const parts = [json.descriptionPlain || htmlToText(json.description || '')];
    for (const list of Array.isArray(json.lists) ? json.lists : []) {
      parts.push(`${list.text || ''}\n${htmlToText(list.content || '')}`);
    }
    parts.push(json.additionalPlain || '');
    return {
      title: json.text || '',
      company: org,
      location: json.categories?.location || '',
      description: parts.filter(Boolean).join('\n\n'),
    };
  }

  return null;
}

/**
 * Phrases that only a real posting carries. A careers landing page, a cookie
 * wall, or the marketing shell around an embedded board hits at most one.
 */
const JD_SIGNALS = [
  /responsibilit/i,
  /qualificat/i,
  /requirements?\b/i,
  /what you.{0,3}ll (?:do|bring|own|be doing)/i,
  /years? of (?:relevant )?experience/i,
  /nice[- ]to[- ]have|preferred (?:skills|qualifications|experience)/i,
  /job description|about (?:the|this) role|the opportunity/i,
  /compensation|salary range|benefits package|equal opportunity/i,
];

/**
 * True when extracted page text plausibly IS a job description.
 *
 * The evaluator needs real JD text; handed a JD-less shell it burns an LLM call
 * and fails with an opaque "missing Block A…G". Failing here instead lets the
 * bot say "paste the JD text" — the thing that actually works. Exported for tests.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeJd(text) {
  const s = String(text || '');
  if (s.length < 500) return false;
  return JD_SIGNALS.filter((re) => re.test(s)).length >= 2;
}

/**
 * Turn browser-extract.mjs's compact JSON ({url,title,text}) into the plain
 * "Title: …\n\n<body>" shape the API path emits, so the evaluator always sees
 * prose rather than a JSON blob. Non-JSON input passes through. Exported for tests.
 *
 * @param {string} stdout
 * @returns {string}
 */
export function flattenBrowserExtract(stdout) {
  const trimmed = String(stdout || '').trim();
  if (!trimmed.startsWith('{')) return trimmed;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
  if (typeof parsed?.text !== 'string') return trimmed;
  return [
    parsed.title ? `Title: ${parsed.title}` : '',
    parsed.url ? `URL: ${parsed.url}` : '',
    '',
    parsed.text,
  ].filter((line, i) => line !== '' || i === 2).join('\n').trim();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node jd-fetch.mjs <job-url>');
    process.exit(2);
  }

  let parsed = parseJobUrl(url);
  if (!parsed) {
    // Company-hosted page embedding an ATS board (?gh_jid= / ?ashby_jid=).
    try {
      parsed = await discoverEmbeddedBoard(url);
      if (parsed) console.error(`jd-fetch: resolved embedded ${parsed.kind} board "${parsed.org}" from the page`);
    } catch (err) {
      console.error(`jd-fetch: embedded-board discovery failed (${err.message}) — trying browser extraction`);
    }
  }

  if (parsed) {
    try {
      const jd = await fetchViaApi(parsed);
      if (jd && jd.description.length > 100) {
        console.log(`Title: ${jd.title}\nCompany: ${jd.company}\nLocation: ${jd.location}\n\n${jd.description}`);
        process.exit(0);
      }
      console.error(`jd-fetch: ${parsed.kind} API had no description for this posting — trying browser extraction`);
    } catch (err) {
      console.error(`jd-fetch: ${parsed.kind} API failed (${err.message}) — trying browser extraction`);
    }
  }

  // Fallback: full browser extraction (needs Playwright browsers installed).
  let out;
  try {
    out = execFileSync(process.execPath, [join(__dirname, 'browser-extract.mjs'), url], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024 * 10,
    });
  } catch (err) {
    // Surface the browser's real failure so the bot can relay an actionable
    // cause (e.g. "Executable doesn't exist" → chromium not installed).
    const tail = String(err.stderr || err.message || '')
      .split('\n').filter(Boolean).slice(-3).join(' · ');
    console.error(`jd-fetch: browser extraction failed too — ${tail}`);
    process.exit(1);
  }

  const text = flattenBrowserExtract(out);
  if (!looksLikeJd(text)) {
    console.error(
      'jd-fetch: the page loaded but holds no job description '
      + `(${text.length} chars of page chrome — login wall, or a board embedded in a frame we could not resolve).`,
    );
    process.exit(1);
  }
  process.stdout.write(text);
}
