// tests/providers/serpapi.test.mjs — SerpApi Google Jobs adapter (no network).
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — serpapi');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/serpapi.mjs')).href);
  const serpapi = mod.default;
  const { normalizeSerpJob, parsePostedAt } = mod;

  if (serpapi.id === 'serpapi') pass('serpapi.id is "serpapi"');
  else fail(`serpapi.id = ${JSON.stringify(serpapi.id)}`);

  // --- parsePostedAt ------------------------------------------------------
  const now = Date.UTC(2026, 6, 23);
  if (parsePostedAt('3 days ago', now) === now - 3 * 86400e3) pass('parsePostedAt handles "3 days ago"');
  else fail(`parsePostedAt days = ${parsePostedAt('3 days ago', now)}`);
  if (parsePostedAt('14 hours ago', now) === now - 14 * 3600e3) pass('parsePostedAt handles hours');
  else fail('parsePostedAt hours failed');
  if (parsePostedAt('just now') === undefined) pass('parsePostedAt returns undefined when unparseable');
  else fail('parsePostedAt should be undefined for "just now"');

  // --- normalizeSerpJob ---------------------------------------------------
  const row = normalizeSerpJob({
    title: 'Senior QA Automation Engineer',
    company_name: 'Acme Corp',
    location: 'Toronto, ON, Canada',
    via: 'via LinkedIn',
    description: 'Build <b>test</b> automation &amp; frameworks.',
    detected_extensions: { posted_at: '2 days ago' },
    apply_options: [{ title: 'LinkedIn', link: 'https://www.linkedin.com/jobs/view/123' }],
    related_links: [{ link: 'https://acme.com/careers' }],
  });
  if (row && row.title === 'Senior QA Automation Engineer' && row.company === 'Acme Corp' && row.location === 'Toronto, ON, Canada')
    pass('normalizeSerpJob maps title/company/location');
  else fail(`normalizeSerpJob = ${JSON.stringify(row)}`);
  if (row && row.url === 'https://www.linkedin.com/jobs/view/123')
    pass('normalizeSerpJob prefers the real apply_options link (canonical dedup url)');
  else fail(`normalizeSerpJob url = ${row?.url}`);
  if (row && row.description === 'Build test automation & frameworks.')
    pass('normalizeSerpJob strips HTML + decodes entities in description');
  else fail(`normalizeSerpJob desc = ${JSON.stringify(row?.description)}`);
  if (row && typeof row.postedAt === 'number') pass('normalizeSerpJob maps detected_extensions.posted_at');
  else fail('normalizeSerpJob postedAt missing');

  if (normalizeSerpJob({ company_name: 'X' }) === null) pass('normalizeSerpJob drops rows with no title');
  else fail('should drop no-title rows');
  if (normalizeSerpJob({ title: 'Role' }) === null) pass('normalizeSerpJob drops rows with no apply url');
  else fail('should drop no-url rows (needed as dedup key)');
  // related_links fallback when apply_options absent
  const fb = normalizeSerpJob({ title: 'Dev', company_name: 'Y', related_links: [{ link: 'https://y.com/job' }] });
  if (fb && fb.url === 'https://y.com/job') pass('normalizeSerpJob falls back to related_links');
  else fail(`related_links fallback = ${JSON.stringify(fb)}`);

  // --- fetch(): no key → graceful skip (no throw, no scan error) ----------
  const savedKey = process.env.SERPAPI_KEY;
  delete process.env.SERPAPI_KEY;
  try {
    const out = await serpapi.fetch({ name: 'GJ', provider: 'serpapi', q: 'qa' }, { fetchJson: async () => ({ jobs_results: [] }) });
    if (Array.isArray(out) && out.length === 0) pass('serpapi.fetch() skips gracefully without a key (returns [])');
    else fail('no-key fetch should return []');
  } finally {
    if (savedKey === undefined) delete process.env.SERPAPI_KEY; else process.env.SERPAPI_KEY = savedKey;
  }

  // --- fetch(): request shape + normalization -----------------------------
  process.env.SERPAPI_KEY = 'test-key';
  let capturedUrl = null;
  const jobs = await serpapi.fetch(
    { name: 'GJ', provider: 'serpapi', q: 'senior qa', location: 'Canada', max_pages: 1 },
    { fetchJson: async (url) => { capturedUrl = url; return { jobs_results: [{ title: 'QA Lead', company_name: 'Z', apply_options: [{ link: 'https://z.com/j' }] }] }; } },
  );
  delete process.env.SERPAPI_KEY;
  const cu = new URL(capturedUrl);
  if (cu.hostname === 'serpapi.com' && cu.searchParams.get('engine') === 'google_jobs' && cu.searchParams.get('q') === 'senior qa' && cu.searchParams.get('location') === 'Canada')
    pass('serpapi.fetch() builds the google_jobs query with q + location');
  else fail(`serpapi.fetch() url = ${capturedUrl}`);
  if (jobs.length === 1 && jobs[0].url === 'https://z.com/j') pass('serpapi.fetch() normalizes results');
  else fail(`serpapi.fetch() jobs = ${JSON.stringify(jobs)}`);
} catch (err) {
  fail(`serpapi test crashed: ${err.message}`);
}
