// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Generic schema.org JSON-LD provider — harvests <script type="application/ld+json">
// JobPosting blocks from any careers page that publishes them (the same
// structured data Google for Jobs consumes; companies embed it precisely so
// bots can read it). One provider unlocks the long tail of career sites that
// have no dedicated ATS API.
//
// Not auto-detected (any URL could host JSON-LD): wire in explicitly with
// `provider: jsonld` and point `careers_url:` (or `api:`) at the page that
// embeds the JobPosting markup. Handles single objects, arrays, @graph
// containers, and ItemList wrappers.

const SCRIPT_RE = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** @param {string} url */
function assertHttpsUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`jsonld: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`jsonld: URL must use HTTPS: ${url}`);
  return url;
}

/** True when a node's @type names JobPosting (string or array form). */
function isJobPosting(node) {
  const t = node?.['@type'];
  if (typeof t === 'string') return t.toLowerCase() === 'jobposting';
  if (Array.isArray(t)) return t.some((x) => typeof x === 'string' && x.toLowerCase() === 'jobposting');
  return false;
}

/**
 * Flatten one parsed JSON-LD document into candidate nodes: the node itself,
 * array elements, @graph members, and ItemList itemListElement entries
 * (which may wrap the payload in { item: {...} }).
 * @param {any} doc
 * @returns {any[]}
 */
export function collectNodes(doc) {
  if (!doc || typeof doc !== 'object') return [];
  if (Array.isArray(doc)) return doc.flatMap(collectNodes);
  const nodes = [doc];
  if (Array.isArray(doc['@graph'])) nodes.push(...doc['@graph'].flatMap(collectNodes));
  if (Array.isArray(doc.itemListElement)) {
    for (const el of doc.itemListElement) {
      if (el && typeof el === 'object') nodes.push(...collectNodes(el.item ?? el));
    }
  }
  return nodes;
}

/** Strip tags, decode the handful of entities JD snippets carry, squash space. */
function plainText(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Compose a display location from a schema.org jobLocation (object or array). */
function extractLocation(posting) {
  const locs = Array.isArray(posting.jobLocation) ? posting.jobLocation : [posting.jobLocation];
  for (const loc of locs) {
    const addr = loc?.address;
    if (typeof addr === 'string' && addr.trim()) return addr.trim();
    if (addr && typeof addr === 'object') {
      const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry]
        .map((p) => (typeof p === 'string' ? p.trim() : (typeof p?.name === 'string' ? p.name.trim() : '')))
        .filter(Boolean);
      if (parts.length) return parts.join(', ');
    }
  }
  const type = posting.jobLocationType;
  if (typeof type === 'string' && type.toUpperCase().includes('TELECOMMUTE')) return 'Remote';
  return '';
}

/**
 * Normalize one JobPosting node. Exported for unit tests.
 *
 * Field mapping:
 *   title                       → title
 *   url (resolved vs page URL)  → url
 *   hiringOrganization.name     → company (fallback: entry name)
 *   jobLocation → address       → location ("Locality, Region, Country";
 *                                 TELECOMMUTE → "Remote")
 *   description (tags stripped) → description
 *   datePosted                  → postedAt (epoch ms)
 *
 * Returns null when title or a resolvable absolute http(s) url is missing —
 * the url is the scanner's dedup key, so postings without their own URL are
 * dropped rather than collapsed onto the page URL.
 *
 * @param {any} posting
 * @param {string} pageUrl - The page the markup was found on (base for relative URLs).
 * @param {string} [fallbackCompany]
 */
export function normalizeJsonldJob(posting, pageUrl, fallbackCompany = '') {
  if (!isJobPosting(posting)) return null;
  const title = plainText(posting.title);
  if (!title) return null;

  let url = '';
  if (typeof posting.url === 'string' && posting.url.trim()) {
    try {
      const resolved = new URL(posting.url.trim(), pageUrl);
      if (/^https?:$/.test(resolved.protocol)) url = resolved.toString();
    } catch { /* unresolvable → dropped below */ }
  }
  if (!url) return null;

  const org = posting.hiringOrganization;
  const company =
    plainText(typeof org === 'string' ? org : (org?.name ?? org?.legalName))
    || (fallbackCompany || '').trim();

  /** @type {{ title: string, url: string, company: string, location: string,
   *           description?: string, postedAt?: number }} */
  const job = { title, url, company, location: extractLocation(posting) };
  const description = plainText(posting.description);
  if (description) job.description = description;
  const postedAt = typeof posting.datePosted === 'string' ? Date.parse(posting.datePosted) : NaN;
  if (Number.isFinite(postedAt)) job.postedAt = postedAt;
  return job;
}

/** @type {Provider} */
export default {
  id: 'jsonld',

  async fetch(entry, ctx) {
    const pageUrl = entry?.api || entry?.careers_url;
    if (!pageUrl) {
      throw new Error(`jsonld: entry "${entry?.name ?? '?'}" needs careers_url (or api) pointing at the page with JobPosting markup`);
    }
    assertHttpsUrl(pageUrl);
    // redirect:'error' prevents SSRF via server-side redirects
    const html = await ctx.fetchText(pageUrl, { redirect: 'error' });

    const jobs = [];
    for (const match of String(html).matchAll(SCRIPT_RE)) {
      let doc;
      try {
        doc = JSON.parse(match[1]);
      } catch {
        continue; // tolerate malformed blocks — other scripts on the page may parse fine
      }
      for (const node of collectNodes(doc)) {
        const job = normalizeJsonldJob(node, pageUrl, entry?.name);
        if (job) jobs.push(job);
      }
    }
    return jobs;
  },
};
