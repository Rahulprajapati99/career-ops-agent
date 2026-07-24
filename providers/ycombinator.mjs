// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Y Combinator provider — reads YC's OWN public jobs board at
// https://www.ycombinator.com/jobs, the front door for Work at a Startup.
//
// Why this source (and not the alternatives):
//   - workatastartup.com itself requires a logged-in session: it answers
//     anonymous clients with HTTP 406, so it is not scrapeable and not usable.
//   - Guessing each YC company's ATS slug (job-boards.greenhouse.io/<slug>, …)
//     was measured at roughly a 1% hit rate — ~300 requests to find a single
//     company — because most YC startups hire only through Work at a Startup.
//     That discovery path already exists anyway as `scan-ats-full.mjs --seeds yc`.
//   - www.ycombinator.com/jobs is explicitly allowed by YC's robots.txt (only
//     /companies?*, /library?* and /verify/* are disallowed) and server-renders
//     the full posting list as JSON, so no login, no key, and no DOM scraping.
//
// The page is an Inertia.js app: the server embeds the page payload as
// HTML-escaped JSON in a `data-page="…"` attribute. props.jobPostings is a
// clean, structured array (title, location, salary, visa, skills, company,
// batch, …) — richer than most ATS feeds.
//
// Listings are split by role category, one server-rendered path each
// (/jobs/role/<path>). An UNKNOWN path silently falls back to the engineering
// list rather than 404ing, so every response is verified against the category
// it claimed to serve (props.jobCategory) before its jobs are accepted —
// otherwise a typo would quietly duplicate the eng list 11 times.
//
// Zero auth, zero LLM tokens, one request per role category.
//
// Wire in via a `job_boards:` entry with `provider: ycombinator`, plus optional:
//   roles     — role categories to pull. Default: all of them. Valid values are
//               the keys of ROLE_PATHS below (eng, design, product, science,
//               sales, marketing, support, operations, recruiting, finance,
//               legal). scan.mjs's title_filter still gates the results.
//   max_jobs  — cap on postings returned per scan (default 500, hard cap 2000).

import { decodeEntities } from './_html-entities.mjs';

const ORIGIN = 'https://www.ycombinator.com';
const TRUSTED_HOST = 'www.ycombinator.com';
const DEFAULT_MAX_JOBS = 500;
const MAX_JOBS_CAP = 2000;

// Role category (as reported by props.jobCategory) → its server-rendered path.
// Verified live: each path returns that category; unknown paths fall back to eng.
export const ROLE_PATHS = {
  eng: 'software-engineer',
  design: 'design',
  product: 'product-manager',
  science: 'science',
  sales: 'sales',
  marketing: 'marketing',
  support: 'support',
  operations: 'operations',
  recruiting: 'recruiting',
  finance: 'finance',
  legal: 'legal',
};

/** @param {string} role */
export function roleUrl(role) {
  const path = ROLE_PATHS[role];
  return path ? `${ORIGIN}/jobs/role/${path}` : null;
}

/**
 * Resolve the requested role categories, preserving order and dropping unknown
 * ids. Falls back to every category. Exported for tests.
 * @param {any} entry
 * @returns {string[]}
 */
export function resolveRoles(entry) {
  const raw = entry?.roles;
  if (!Array.isArray(raw)) return Object.keys(ROLE_PATHS);
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    if (typeof r !== 'string') continue;
    const id = r.trim().toLowerCase();
    if (ROLE_PATHS[id] && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out.length ? out : Object.keys(ROLE_PATHS);
}

/** Resolve the posting cap: positive integer `max_jobs`, capped. */
export function resolveMaxJobs(entry) {
  const v = entry?.max_jobs;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_JOBS_CAP);
  return DEFAULT_MAX_JOBS;
}

/**
 * Pull the Inertia page payload out of the rendered HTML.
 *
 * The attribute value is HTML-escaped JSON, so every internal quote arrives as
 * `&quot;` — `[^"]*` therefore captures the whole value safely and stops at the
 * real closing quote. Returns null when the attribute is missing or the JSON
 * doesn't parse (layout change → the caller reports it rather than crashing).
 *
 * Exported for tests.
 * @param {string} html
 * @returns {any|null}
 */
export function extractPageData(html) {
  if (typeof html !== 'string') return null;
  const m = html.match(/data-page="([^"]*)"/);
  if (!m) return null;
  try {
    // decodeEntities is single-pass, so an escaped "&amp;quot;" in the source
    // data can't be double-decoded into a quote that breaks out of the JSON.
    return JSON.parse(decodeEntities(m[1]));
  } catch {
    return null;
  }
}

/**
 * Parse YC's relative posting age ("16 days", "20 hours", "3 months") to epoch
 * ms. Returns undefined for anything unrecognized — a missing date must never
 * be treated as "posted now". Exported for tests.
 * @param {unknown} s
 * @param {number} [now]
 */
export function parseRelativeAge(s, now = Date.now()) {
  const m = String(s ?? '').match(/(\d+)\s*(minute|hour|day|week|month|year)/i);
  if (!m) return undefined;
  const unit = {
    minute: 60e3,
    hour: 3600e3,
    day: 86400e3,
    week: 604800e3,
    month: 2592000e3,   // 30d, same convention as providers/serpapi.mjs
    year: 31536000e3,
  }[m[2].toLowerCase()];
  return unit ? now - Number(m[1]) * unit : undefined;
}

/**
 * Build the absolute posting URL, host-locked to www.ycombinator.com.
 * Accepts the site-relative form the payload actually uses ("/companies/…")
 * and tolerates an absolute URL as long as it stays on YC's host. Anything
 * else returns null and drops the posting — the url is the dedup key and is
 * written to the pipeline, so it must never point off-site.
 *
 * Exported for tests.
 * @param {unknown} raw
 * @returns {string|null}
 */
export function absolutePostingUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const value = raw.trim();
  try {
    // Site-relative values resolve against ORIGIN; absolute ones keep their own
    // host, which the check below then rejects when it isn't YC's.
    const parsed = new URL(value, ORIGIN);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.hostname !== TRUSTED_HOST) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Normalize one YC posting into the canonical Job shape. Exported for tests.
 *
 * Field mapping:
 *   - title:    `title` (dropped when empty).
 *   - url:      `url` made absolute + host-locked (dropped when unusable).
 *   - company:  `companyName`, falling back to the entry name, then "Y Combinator".
 *   - location: `location` — YC packs multiple sites into one string
 *               ("San Francisco, CA, US / Remote (US)"); passed through as-is so
 *               geo-policy.mjs and location_filter see every listed location.
 *   - postedAt: `createdAt`, a relative age string, converted to epoch ms.
 *   - description: the one-liner plus a compact facts line (batch, type, salary,
 *               visa) and any listed skills — all already present in the list
 *               payload, so this stays a zero-extra-request provider.
 *
 * @param {any} j
 * @param {string} [fallbackCompany]
 * @param {number} [now]
 */
export function normalizeYcJob(j, fallbackCompany, now = Date.now()) {
  if (!j || typeof j !== 'object') return null;

  const title = typeof j.title === 'string' ? j.title.trim() : '';
  if (!title) return null;

  const url = absolutePostingUrl(j.url);
  if (!url) return null;

  const company =
    typeof j.companyName === 'string' && j.companyName.trim()
      ? j.companyName.trim()
      : fallbackCompany || 'Y Combinator';

  const location = typeof j.location === 'string' ? j.location.trim() : '';

  /** @type {{title:string,url:string,company:string,location:string,description?:string,postedAt?:number}} */
  const job = { title, url, company, location };

  // Description is assembled from fields the list payload already carries.
  const facts = [
    typeof j.companyBatchName === 'string' && j.companyBatchName.trim() ? `YC ${j.companyBatchName.trim()}` : '',
    typeof j.type === 'string' ? j.type.trim() : '',
    typeof j.salaryRange === 'string' ? j.salaryRange.trim() : '',
    typeof j.visa === 'string' && j.visa.trim() ? `Visa: ${j.visa.trim()}` : '',
  ].filter(Boolean).join(' · ');
  const skills = Array.isArray(j.skills)
    ? j.skills.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()).join(', ')
    : '';
  const description = [
    typeof j.companyOneLiner === 'string' ? j.companyOneLiner.trim() : '',
    facts,
    skills ? `Skills: ${skills}` : '',
  ].filter(Boolean).join('\n');
  if (description) job.description = description.slice(0, 4000);

  const postedAt = parseRelativeAge(j.createdAt, now);
  if (postedAt !== undefined) job.postedAt = postedAt;

  return job;
}

/** @type {Provider} */
export default {
  id: 'ycombinator',

  detect(entry) {
    const url = entry?.careers_url || '';
    return /^https:\/\/(?:www\.)?ycombinator\.com\/jobs(?:[/?#]|$)/i.test(url) ? { url } : null;
  },

  async fetch(entry, ctx) {
    const roles = resolveRoles(entry);
    const maxJobs = resolveMaxJobs(entry);
    const fallbackCompany = entry?.name;

    // Dedup by posting URL: a job can surface under more than one role list.
    /** @type {Map<string, any>} */
    const byUrl = new Map();
    let served = 0;

    for (const role of roles) {
      if (byUrl.size >= maxJobs) break;

      const url = roleUrl(role);
      if (!url) continue;
      if (new URL(url).hostname !== TRUSTED_HOST) throw new Error(`ycombinator: untrusted host in ${url}`);

      let html;
      try {
        // redirect:'error' prevents SSRF via server-side redirects.
        html = await ctx.fetchText(url, { redirect: 'error' });
      } catch (err) {
        // One role list failing shouldn't lose the other ten.
        console.error(`⚠️  ycombinator: ${role} list failed — ${err.message}`);
        continue;
      }

      const data = extractPageData(html);
      if (!data) {
        console.error(`⚠️  ycombinator: could not read the ${role} page payload (YC layout may have changed)`);
        continue;
      }

      // Guard the silent eng fallback: only trust a response that serves the
      // category it was asked for.
      const category = data?.props?.jobCategory;
      if (category !== role) continue;
      served++;

      const postings = data?.props?.jobPostings;
      if (!Array.isArray(postings)) continue;

      for (const raw of postings) {
        if (byUrl.size >= maxJobs) break;
        const job = normalizeYcJob(raw, fallbackCompany);
        if (job && !byUrl.has(job.url)) byUrl.set(job.url, job);
      }
    }

    // Every role list failing means the source is broken (layout change, block,
    // outage) — fail loudly rather than reporting "0 new jobs" forever.
    if (served === 0) {
      throw new Error('ycombinator: no role list could be read from www.ycombinator.com/jobs');
    }

    return [...byUrl.values()];
  },
};
