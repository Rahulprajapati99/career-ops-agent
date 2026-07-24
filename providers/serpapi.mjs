// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// SerpApi Google Jobs provider — a single API over Google for Jobs, which
// indexes LinkedIn, Indeed, Greenhouse, ZipRecruiter, company pages, and more.
// This is the highest-coverage source and returns clean JSON.
//
// PER-USER key: set SERPAPI_KEY in the environment (the bot/launcher injects it
// from each user's profile.yml integrations.serpapi_key). Free tier ~100
// searches/month — each page fetched is one search, so max_pages defaults to 1.
// Without a key the provider skips gracefully (returns []), so keyless users
// don't see scan errors.
//
// Wire in via a `job_boards:` entry with `provider: serpapi` plus:
//   q         — query (e.g. "senior qa automation engineer")   [required]
//   location  — Google location string (e.g. "Canada", "United States")
//   max_pages — pages to fetch (default 1, hard cap 5) — conserves quota
//   hl / gl   — language / country (optional)
//   via       — keep ONLY postings that came from this source, e.g. "Wellfound"
//               or "LinkedIn". Google reports the origin board per result
//               ("via Wellfound") and links to it in apply_options, so both are
//               matched. This is how a board that blocks direct API access (as
//               Wellfound does) can still be scanned: Google indexes it, we
//               filter its rows out of the result set. Omit for no filtering.
//               Note it costs the same quota as an unfiltered search but keeps
//               fewer rows — pair it with a broad q.

import { decodeEntities } from './_html-entities.mjs';

const ENDPOINT = 'https://serpapi.com/search.json';
const TRUSTED_HOST = 'serpapi.com';
const DEFAULT_MAX_PAGES = 1;
const HARD_PAGE_CAP = 5;

function clean(s) {
  if (typeof s !== 'string') return '';
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Parse Google's relative "posted_at" ("3 days ago") to epoch ms. Exported. */
export function parsePostedAt(s, now = Date.now()) {
  const m = String(s || '').match(/(\d+)\s*(minute|hour|day|week|month)/i);
  if (!m) return undefined;
  const ms = { minute: 60e3, hour: 3600e3, day: 86400e3, week: 604800e3, month: 2592000e3 }[m[2].toLowerCase()];
  return ms ? now - Number(m[1]) * ms : undefined;
}

/**
 * Normalize a Google Jobs result into the canonical Job shape. Exported.
 * Prefers the real apply URL (apply_options / related_links) so cross-source
 * dedup keys on the canonical board link, not a Google redirect.
 * @param {any} j
 */
export function normalizeSerpJob(j) {
  if (!j || typeof j !== 'object') return null;
  const title = clean(j.title);
  if (!title) return null;
  const url = (Array.isArray(j.apply_options) && j.apply_options[0]?.link)
    || (Array.isArray(j.related_links) && j.related_links[0]?.link)
    || '';
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const company = clean(j.company_name) || 'Unknown';
  const location = clean(j.location);
  /** @type {{title:string,url:string,company:string,location:string,description?:string,postedAt?:number}} */
  const job = { title, url: url.trim(), company, location };
  const description = clean(j.description);
  if (description) job.description = description.slice(0, 4000);
  const postedAt = parsePostedAt(j.detected_extensions?.posted_at);
  if (postedAt) job.postedAt = postedAt;
  return job;
}

/**
 * Does a raw Google Jobs result come from the named board? Matches the `via`
 * label ("via Wellfound") and, as a fallback, the host of any apply/related
 * link — a Wellfound row always links back to wellfound.com even when the
 * label is localized. Comparison is case-insensitive and non-alphanumeric
 * characters are dropped, so "Work at a Startup" matches "workatastartup".
 * Exported for tests.
 *
 * @param {any} j        Raw jobs_results row.
 * @param {string} via   Board name from the portal entry.
 */
export function matchesVia(j, via) {
  const want = String(via || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!want) return true;
  const label = String(j?.via || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (label.includes(want)) return true;
  const links = [
    ...(Array.isArray(j?.apply_options) ? j.apply_options.map((o) => o?.link) : []),
    ...(Array.isArray(j?.related_links) ? j.related_links.map((o) => o?.link) : []),
  ];
  for (const link of links) {
    if (typeof link !== 'string') continue;
    try {
      // Compare the HOST only: a query string could otherwise mention any board.
      if (new URL(link).hostname.toLowerCase().replace(/[^a-z0-9]/g, '').includes(want)) return true;
    } catch { /* malformed link — ignore */ }
  }
  return false;
}

function pageCap(entry) {
  const v = entry?.max_pages;
  const n = Number.isInteger(v) && v > 0 ? v : DEFAULT_MAX_PAGES;
  return Math.min(n, HARD_PAGE_CAP);
}

/** @type {Provider} */
export default {
  id: 'serpapi',

  async fetch(entry, ctx) {
    const key = process.env.SERPAPI_KEY;
    if (!key) {
      console.warn('⚠️  serpapi: no SERPAPI_KEY set — skipping (add integrations.serpapi_key to your profile to enable).');
      return [];
    }
    const q = typeof entry?.q === 'string' ? entry.q.trim() : '';
    if (!q) throw new Error(`serpapi: entry "${entry?.name ?? '?'}" needs a q (search query)`);

    const maxPages = pageCap(entry);
    const all = [];
    let nextToken = null;
    for (let page = 0; page < maxPages; page++) {
      const u = new URL(ENDPOINT);
      u.searchParams.set('engine', 'google_jobs');
      u.searchParams.set('q', q);
      u.searchParams.set('api_key', key);
      u.searchParams.set('hl', typeof entry?.hl === 'string' ? entry.hl : 'en');
      if (typeof entry?.location === 'string' && entry.location.trim()) u.searchParams.set('location', entry.location.trim());
      if (typeof entry?.gl === 'string' && entry.gl.trim()) u.searchParams.set('gl', entry.gl.trim());
      if (nextToken) u.searchParams.set('next_page_token', nextToken);
      if (u.hostname !== TRUSTED_HOST) throw new Error(`serpapi: untrusted host ${u.hostname}`);

      const json = await ctx.fetchJson(u.toString(), { redirect: 'error' });
      if (json?.error) throw new Error(`serpapi: ${json.error}`);
      const results = Array.isArray(json?.jobs_results) ? json.jobs_results : [];
      all.push(...results);
      nextToken = json?.serpapi_pagination?.next_page_token || null;
      if (!nextToken) break; // last page
    }
    // Source filter runs on the RAW rows: `via` and the apply links are dropped
    // by normalization, so it can't be applied afterwards.
    const via = typeof entry?.via === 'string' ? entry.via.trim() : '';
    const rows = via ? all.filter((j) => matchesVia(j, via)) : all;
    return rows.map(normalizeSerpJob).filter(Boolean);
  },
};
