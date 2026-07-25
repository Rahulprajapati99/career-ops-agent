// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Communitech provider — the Waterloo-region tech job board at
// www1.communitech.ca/jobs. Especially relevant to a Kitchener/Waterloo/Toronto
// search: it aggregates postings from Canadian tech employers that often never
// reach the big aggregators.
//
// Why this shape (all measured 2026-07-25):
//   - The board is a Next.js app that server-renders its results into the
//     standard `__NEXT_DATA__` script tag, so no login, no key, no DOM scraping.
//     props.pageProps.initialState.jobs.found is a clean array carrying title,
//     organization, url, salary in CENTS with currency+period, workMode,
//     seniority, skills and a unix createdAt — richer than most ATS feeds.
//   - robots.txt does NOT disallow /jobs.
//   - `?page=N` is NOT server-rendered: page 2 returns page 1's payload, so
//     pagination is unavailable to a no-JS client. `?q=<terms>` IS honored
//     server-side, which is the better lever anyway — one targeted request per
//     search term beats paging through unrelated roles. Each request returns
//     up to 20 postings.
//
// The posting `url` points at the EMPLOYER's own career page (Deloitte, Shopify,
// …), not back at Communitech, so it is validated as an absolute http(s) URL but
// deliberately NOT host-locked — host-locking would drop every row.
//
// Wire in via a `job_boards:` entry with `provider: communitech`, plus optional:
//   queries   — search terms, one request each. Defaults to a single unfiltered
//               request (the newest 20 postings). scan.mjs's title_filter still
//               gates whatever comes back.
//   max_jobs  — cap per scan (default 200, hard cap 1000).

import { decodeEntities } from './_html-entities.mjs';

const ORIGIN = 'https://www1.communitech.ca';
const BOARD_HOST = 'www1.communitech.ca';
const DEFAULT_MAX_JOBS = 200;
const MAX_JOBS_CAP = 1000;
const PER_REQUEST = 20; // what the board server-renders

/**
 * Pull the Next.js payload out of the rendered HTML.
 *
 * The script body is raw JSON (not HTML-escaped like YC's data-page attribute),
 * so it is parsed directly; entities are decoded only as a fallback for the
 * escaped variant. Returns null when the tag is missing or unparseable, so a
 * site redesign is reported rather than crashing the scan.
 *
 * @param {string} html
 * @returns {any|null}
 */
export function extractNextData(html) {
  if (typeof html !== 'string') return null;
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    try { return JSON.parse(decodeEntities(m[1])); } catch { return null; }
  }
}

/**
 * The postings array, wherever the payload keeps it.
 * @param {any} data
 * @returns {any[]}
 */
export function postingsOf(data) {
  const found = data?.props?.pageProps?.initialState?.jobs?.found;
  return Array.isArray(found) ? found : [];
}

/**
 * Search terms to request. One HTTP request per term; an empty list means a
 * single unfiltered request for the newest postings. Exported for tests.
 *
 * @param {any} entry
 * @returns {string[]}
 */
export function resolveQueries(entry) {
  const raw = entry?.queries;
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
  if (!Array.isArray(raw)) return [''];
  const out = [];
  const seen = new Set();
  for (const q of raw) {
    if (typeof q !== 'string') continue;
    const s = q.trim();
    if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); }
  }
  return out.length ? out : [''];
}

/** Resolve the per-scan posting cap. */
export function resolveMaxJobs(entry) {
  const v = entry?.max_jobs;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_JOBS_CAP);
  return DEFAULT_MAX_JOBS;
}

/** Board URL for one search term. */
export function searchUrl(query) {
  const u = new URL(`${ORIGIN}/jobs`);
  if (query) u.searchParams.set('q', query);
  return u.toString();
}

/**
 * Human-readable pay from the cents fields, or '' when the board publishes none.
 *
 * Values arrive as integer cents with an explicit currency and period, so this
 * divides by 100 rather than guessing magnitude. Only emitted when
 * compensationPublic is true — an employer that withheld pay must not have a
 * number invented for it. Exported for tests.
 *
 * @param {any} j
 * @returns {string}
 */
export function formatCompensation(j) {
  if (!j || j.compensationPublic !== true) return '';
  const min = Number(j.compensationAmountMinCents);
  const max = Number(j.compensationAmountMaxCents);
  const cur = typeof j.compensationCurrency === 'string' ? j.compensationCurrency.toUpperCase() : '';
  const per = typeof j.compensationPeriod === 'string' ? j.compensationPeriod : '';
  const money = (cents) => (Number.isFinite(cents) && cents > 0 ? Math.round(cents / 100).toLocaleString('en-CA') : null);
  const lo = money(min);
  const hi = money(max);
  if (!lo && !hi) return '';
  const range = lo && hi && lo !== hi ? `${lo} - ${hi}` : (lo || hi);
  return [cur, range, per ? `per ${per}` : ''].filter(Boolean).join(' ').trim();
}

/**
 * Location for a posting.
 *
 * The structured location arrays are populated for only some rows (measured
 * 6/20), but the title very often ends with a parenthesised location —
 * "… (Toronto, ON, CA, M5H 0A9)". So: structured data first, then that
 * parenthetical, and finally the work mode alone. Remote is appended when the
 * board flags it, because geo-policy reads the location string to rank remote
 * roles first. Exported for tests.
 *
 * @param {any} j
 * @returns {string}
 */
export function extractLocation(j) {
  const fromArray = (a) => (Array.isArray(a) ? a : [])
    .map((x) => (typeof x === 'string' ? x : x?.name || x?.city || ''))
    .filter(Boolean);
  let parts = [...fromArray(j?.locations), ...fromArray(j?.searchableLocations), ...fromArray(j?.locationDetails)];

  if (parts.length === 0 && typeof j?.title === 'string') {
    // Trailing "(City, PROV, CC, POSTAL)" — keep the city/province, drop a
    // postal code, which is noise for geography matching.
    const paren = j.title.match(/\(([^()]{3,80})\)\s*$/);
    if (paren) {
      const cleaned = paren[1]
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s && !/^[A-Z]\d[A-Z]\s*\d[A-Z]\d$/i.test(s))
        .join(', ');
      if (cleaned) parts = [cleaned];
    }
  }

  const remote = j?.workMode === 'remote';
  const hybrid = j?.workMode === 'hybrid';
  const loc = [...new Set(parts)].join(' / ');
  if (remote) return loc ? `${loc} (Remote)` : 'Remote';
  if (hybrid && loc) return `${loc} (Hybrid)`;
  return loc;
}

/** Strip the trailing "(location)" the board packs into titles. */
function cleanTitle(raw) {
  const t = String(raw || '').trim();
  // Only strip when the parenthetical looks like a location (has a comma or a
  // province/state code) — "(Future Opportunity)" and "(Remote)" stay.
  return t.replace(/\s*\(([^()]*,[^()]*)\)\s*$/, (whole, inner) => (/\d|[A-Z]{2}\b/.test(inner) ? '' : whole)).trim() || t;
}

/**
 * Normalize one Communitech posting into the canonical Job shape.
 * Exported for tests.
 *
 * @param {any} j
 * @param {string} [fallbackCompany]
 * @returns {object|null}
 */
export function normalizeCommunitechJob(j, fallbackCompany) {
  if (!j || typeof j !== 'object') return null;

  const title = cleanTitle(j.title);
  if (!title) return null;

  // The url is an employer career page, so it cannot be host-locked — but it
  // must still be an absolute http(s) URL, since it becomes the dedup key and
  // is written into the pipeline.
  let url = '';
  try {
    const parsed = new URL(String(j.url || ''));
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    url = parsed.href;
  } catch { return null; }

  const company = (typeof j.organization?.name === 'string' && j.organization.name.trim())
    ? j.organization.name.trim()
    : (fallbackCompany || 'Communitech');

  /** @type {{title:string,url:string,company:string,location:string,compensation?:string,description?:string,postedAt?:number}} */
  const job = { title, url, company, location: extractLocation(j) };

  const pay = formatCompensation(j);
  if (pay) job.compensation = pay;

  // createdAt is unix SECONDS. Guard the range so a millisecond value or a
  // sentinel zero never becomes a nonsense date.
  const secs = Number(j.createdAt);
  if (Number.isFinite(secs) && secs > 946_684_800 && secs < 4_102_444_800) job.postedAt = secs * 1000;

  const facts = [
    typeof j.seniority === 'string' && j.seniority ? `Seniority: ${j.seniority}` : '',
    j.workMode ? `Work mode: ${String(j.workMode).replace(/_/g, '-')}` : '',
    j.compensationOffersEquity === true ? 'Equity offered' : '',
  ].filter(Boolean).join(' · ');
  const skills = Array.isArray(j.skills)
    ? j.skills.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()).slice(0, 25).join(', ')
    : '';
  const description = [facts, skills ? `Skills: ${skills}` : ''].filter(Boolean).join('\n');
  if (description) job.description = description.slice(0, 4000);

  return job;
}

/** @type {Provider} */
export default {
  id: 'communitech',

  detect(entry) {
    const url = entry?.careers_url || '';
    return /^https?:\/\/(?:www1?\.)?communitech\.ca\/jobs(?:[/?#]|$)/i.test(url) ? { url } : null;
  },

  async fetch(entry, ctx) {
    const queries = resolveQueries(entry);
    const maxJobs = resolveMaxJobs(entry);
    const fallbackCompany = entry?.name;

    /** @type {Map<string, any>} */
    const byUrl = new Map();
    let served = 0;

    for (const query of queries) {
      if (byUrl.size >= maxJobs) break;
      const url = searchUrl(query);
      if (new URL(url).hostname !== BOARD_HOST) throw new Error(`communitech: untrusted host in ${url}`);

      let html;
      try {
        // redirect:'error' prevents SSRF via a server-side redirect.
        html = await ctx.fetchText(url, { redirect: 'error' });
      } catch (err) {
        // One search failing must not lose the others.
        console.error(`⚠️  communitech: query ${JSON.stringify(query)} failed — ${err.message}`);
        continue;
      }

      const data = extractNextData(html);
      if (!data) {
        console.error('⚠️  communitech: could not read the __NEXT_DATA__ payload (board layout may have changed)');
        continue;
      }
      served += 1;

      const postings = postingsOf(data);
      for (const raw of postings) {
        if (byUrl.size >= maxJobs) break;
        const job = normalizeCommunitechJob(raw, fallbackCompany);
        if (job && !byUrl.has(job.url)) byUrl.set(job.url, job);
      }
      // A search that returns a full page may have more behind it, but the board
      // does not server-render pagination — noted so the cap is not mistaken for
      // the board being exhausted.
      if (postings.length >= PER_REQUEST && queries.length === 1) {
        console.error('ℹ️  communitech: returned a full page; add more `queries:` to widen coverage (the board does not server-render pagination).');
      }
    }

    // Every request failing means the source is broken, not empty — fail loudly
    // rather than reporting "0 new jobs" forever.
    if (served === 0) throw new Error('communitech: no search could be read from www1.communitech.ca/jobs');

    return [...byUrl.values()];
  },
};
