// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Adzuna provider — aggregated job-board API with official country endpoints
// (US, Canada, India, UK, …). Free tier with an app_id/app_key pair.
//
// Endpoint: https://api.adzuna.com/v1/api/jobs/{country}/search/{page}
// Response shape: { results: [...], count } — pages are 1-based.
//
// Credentials are SECRETS and therefore come from the environment, never from
// portals.yml: set ADZUNA_APP_ID and ADZUNA_APP_KEY in .env.
//
// Wire in via a `job_boards:` entry with `provider: adzuna`. Per-entry config:
//   country          — Adzuna country code (default "us"; e.g. us, ca, in, gb)
//   what             — keyword query (e.g. "software engineer")
//   where            — location query (e.g. "Toronto, ON")
//   category         — Adzuna category tag (e.g. "it-jobs"), optional
//   max_days_old     — recency window in days (default 7)
//   max_pages        — page cap (default 3, hard cap 20)
//   results_per_page — page size (default 50, Adzuna max)

import { decodeEntities } from './_html-entities.mjs';

const API_BASE = 'https://api.adzuna.com/v1/api/jobs';
const TRUSTED_HOST = 'api.adzuna.com';

// Countries Adzuna operates official endpoints for (subset we sanity-check
// against so a typo like "usa" fails loudly instead of 404-ing per page).
const COUNTRIES = new Set([
  'at', 'au', 'be', 'br', 'ca', 'ch', 'de', 'es', 'fr', 'gb', 'in', 'it',
  'mx', 'nl', 'nz', 'pl', 'sg', 'us', 'za',
]);

const DEFAULT_MAX_PAGES = 3;
const HARD_PAGE_CAP = 20;
const DEFAULT_RESULTS_PER_PAGE = 50;
const DEFAULT_MAX_DAYS_OLD = 7;

/** Resolve the page cap: a positive integer `max_pages` on the entry, capped. */
function pageCap(entry) {
  const v = entry?.max_pages;
  const n = Number.isInteger(v) && v > 0 ? v : DEFAULT_MAX_PAGES;
  return Math.min(n, HARD_PAGE_CAP);
}

/** @param {string} url */
function assertAdzunaUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error(`adzuna: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`adzuna: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

/**
 * Strip Adzuna's <strong> query-highlight markup (and any other tags) from a
 * text field, then decode HTML entities and collapse whitespace.
 * @param {unknown} s
 */
function cleanText(s) {
  if (typeof s !== 'string') return '';
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Normalize a single result from the Adzuna API response. Exported for tests.
 *
 * Field mapping:
 *   title (highlight markup stripped) → title
 *   redirect_url                      → url
 *   company.display_name              → company
 *   location.display_name             → location
 *   description (snippet)             → description
 *   created (ISO date)                → postedAt (epoch ms)
 *
 * Returns null when required fields (title or url) are missing or invalid.
 *
 * @param {any} j
 * @returns {{ title: string, url: string, company: string, location: string,
 *             description?: string, postedAt?: number } | null}
 */
export function normalizeAdzunaJob(j) {
  if (!j || typeof j !== 'object') return null;
  const title = cleanText(j.title);
  if (!title) return null;
  let url = typeof j.redirect_url === 'string' ? j.redirect_url.trim() : '';
  if (!url || !/^https?:\/\//i.test(url)) return null;
  // Adzuna mints a fresh `se=` session token on every request, so the SAME ad
  // arrives with a different URL each scan and evades URL-based dedup. Drop that
  // volatile param (the stable /land/ad/{id} + utm identity remains).
  try {
    const u = new URL(url);
    u.searchParams.delete('se');
    url = u.toString();
  } catch { /* keep original url */ }
  const company = cleanText(j.company?.display_name) || 'Adzuna';
  const location = cleanText(j.location?.display_name);
  /** @type {ReturnType<typeof normalizeAdzunaJob>} */
  const job = { title, url, company, location };
  const description = cleanText(j.description);
  if (description) job.description = description;
  const postedAt = typeof j.created === 'string' ? Date.parse(j.created) : NaN;
  if (Number.isFinite(postedAt)) job.postedAt = postedAt;
  return job;
}

/** @type {Provider} */
export default {
  id: 'adzuna',

  async fetch(entry, ctx) {
    const appId = process.env.ADZUNA_APP_ID;
    const appKey = process.env.ADZUNA_APP_KEY;
    if (!appId || !appKey) {
      throw new Error(
        'adzuna: missing credentials — set ADZUNA_APP_ID and ADZUNA_APP_KEY in the environment (.env)',
      );
    }

    const country = typeof entry?.country === 'string' && entry.country.trim()
      ? entry.country.trim().toLowerCase()
      : 'us';
    if (!COUNTRIES.has(country)) {
      throw new Error(
        `adzuna: unknown country code "${country}" — use an official Adzuna code (e.g. us, ca, in, gb)`,
      );
    }

    const maxPages = pageCap(entry);
    const perPage = Number.isInteger(entry?.results_per_page) && entry.results_per_page > 0
      ? Math.min(entry.results_per_page, DEFAULT_RESULTS_PER_PAGE)
      : DEFAULT_RESULTS_PER_PAGE;
    const maxDaysOld = Number.isInteger(entry?.max_days_old) && entry.max_days_old > 0
      ? entry.max_days_old
      : DEFAULT_MAX_DAYS_OLD;

    const all = [];
    for (let page = 1; page <= maxPages; page++) {
      const u = new URL(`${API_BASE}/${country}/search/${page}`);
      u.searchParams.set('app_id', appId);
      u.searchParams.set('app_key', appKey);
      u.searchParams.set('results_per_page', String(perPage));
      u.searchParams.set('max_days_old', String(maxDaysOld));
      u.searchParams.set('sort_by', 'date');
      if (typeof entry?.what === 'string' && entry.what.trim()) {
        u.searchParams.set('what', entry.what.trim());
      }
      if (typeof entry?.where === 'string' && entry.where.trim()) {
        u.searchParams.set('where', entry.where.trim());
      }
      if (typeof entry?.category === 'string' && entry.category.trim()) {
        u.searchParams.set('category', entry.category.trim());
      }
      const url = assertAdzunaUrl(u.toString());
      // redirect:'error' prevents SSRF via server-side redirects
      const json = await ctx.fetchJson(url, { redirect: 'error' });
      if (!json || !Array.isArray(json.results)) {
        throw new Error(
          `adzuna: unexpected API response on page ${page} — expected { results: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`,
        );
      }
      all.push(...json.results);
      // Short page → last page; stop early instead of burning quota on 404s.
      if (json.results.length < perPage) break;
    }
    return all.map(normalizeAdzunaJob).filter(Boolean);
  },
};
