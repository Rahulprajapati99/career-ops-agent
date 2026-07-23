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
    return all.map(normalizeSerpJob).filter(Boolean);
  },
};
