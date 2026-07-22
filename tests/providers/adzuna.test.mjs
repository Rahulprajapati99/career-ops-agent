// tests/providers/adzuna.test.mjs — Adzuna provider unit tests (deterministic, no network).
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — adzuna');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/adzuna.mjs')).href);
  const adzuna = mod.default;
  const { normalizeAdzunaJob } = mod;

  if (adzuna.id === 'adzuna') pass('adzuna.id is "adzuna"');
  else fail(`adzuna.id is ${JSON.stringify(adzuna.id)}`);

  if (typeof adzuna.fetch === 'function') pass('adzuna exports a fetch() function');
  else fail('adzuna.fetch should be a function');

  // --- normalizeAdzunaJob -------------------------------------------------
  const row = normalizeAdzunaJob({
    title: 'Senior <strong>Software</strong> Engineer &amp; Lead',
    redirect_url: '  https://www.adzuna.com/land/ad/123  ',
    company: { display_name: '  Acme Corp  ' },
    location: { display_name: 'Toronto, Ontario' },
    description: 'Build <b>things</b> at scale',
    created: '2026-07-20T12:00:00Z',
  });
  if (row && row.title === 'Senior Software Engineer & Lead')
    pass('normalizeAdzunaJob strips highlight markup and decodes entities in title');
  else fail(`normalizeAdzunaJob title = ${JSON.stringify(row?.title)}`);
  if (row && row.url === 'https://www.adzuna.com/land/ad/123' && row.company === 'Acme Corp'
      && row.location === 'Toronto, Ontario')
    pass('normalizeAdzunaJob maps url/company/location with trimming');
  else fail(`normalizeAdzunaJob row = ${JSON.stringify(row)}`);
  if (row && row.description === 'Build things at scale')
    pass('normalizeAdzunaJob strips tags from the description snippet');
  else fail(`normalizeAdzunaJob description = ${JSON.stringify(row?.description)}`);
  if (row && row.postedAt === Date.parse('2026-07-20T12:00:00Z'))
    pass('normalizeAdzunaJob maps created → postedAt (epoch ms)');
  else fail(`normalizeAdzunaJob postedAt = ${JSON.stringify(row?.postedAt)}`);

  if (normalizeAdzunaJob({ redirect_url: 'https://x.example/a' }) === null)
    pass('normalizeAdzunaJob drops rows with no title');
  else fail('normalizeAdzunaJob should drop empty-title rows');
  if (normalizeAdzunaJob({ title: 'T', redirect_url: '/relative' }) === null)
    pass('normalizeAdzunaJob drops rows with a non-absolute url');
  else fail('normalizeAdzunaJob should drop non-absolute urls');

  // --- fetch(): env guard -------------------------------------------------
  const savedId = process.env.ADZUNA_APP_ID;
  const savedKey = process.env.ADZUNA_APP_KEY;
  delete process.env.ADZUNA_APP_ID;
  delete process.env.ADZUNA_APP_KEY;
  try {
    let threw = null;
    try {
      await adzuna.fetch({ name: 'X', provider: 'adzuna' }, { fetchJson: async () => ({ results: [] }) });
    } catch (err) { threw = err; }
    if (threw && /ADZUNA_APP_ID/.test(threw.message))
      pass('adzuna.fetch() fails loudly when credentials are missing');
    else fail(`adzuna.fetch() without creds → ${threw ? threw.message : 'no error'}`);

    // --- fetch(): request shape + pagination + early stop -----------------
    process.env.ADZUNA_APP_ID = 'test-id';
    process.env.ADZUNA_APP_KEY = 'test-key';

    const urls = [];
    let capturedOpts = null;
    const page = (n, count) => ({
      results: Array.from({ length: count }, (_, i) => ({
        title: `Role ${n}-${i}`,
        redirect_url: `https://www.adzuna.ca/land/ad/${n}-${i}`,
        company: { display_name: 'Maple Inc' },
        location: { display_name: 'Vancouver, British Columbia' },
      })),
    });
    // Full page 1 (2 results at per-page 2) then short page 2 → early stop at 2 pages even with max_pages 5.
    const fetched = await adzuna.fetch(
      { name: 'Adzuna CA', provider: 'adzuna', country: 'ca', what: 'software engineer', where: 'Vancouver', results_per_page: 2, max_pages: 5 },
      { fetchJson: async (url, opts) => { urls.push(url); capturedOpts = opts; return page(urls.length, urls.length === 1 ? 2 : 1); } },
    );
    const first = new URL(urls[0]);
    if (first.hostname === 'api.adzuna.com' && first.pathname === '/v1/api/jobs/ca/search/1')
      pass('adzuna.fetch() targets the country endpoint with 1-based pages');
    else fail(`adzuna.fetch() first URL = ${urls[0]}`);
    if (first.searchParams.get('what') === 'software engineer'
        && first.searchParams.get('where') === 'Vancouver'
        && first.searchParams.get('app_id') === 'test-id'
        && first.searchParams.get('max_days_old') === '7')
      pass('adzuna.fetch() passes what/where/credentials/max_days_old params');
    else fail(`adzuna.fetch() params = ${first.searchParams.toString()}`);
    if (capturedOpts && capturedOpts.redirect === 'error')
      pass('adzuna.fetch() passes redirect:"error" to fetchJson (SSRF guard)');
    else fail(`adzuna.fetch() opts = ${JSON.stringify(capturedOpts)}`);
    if (urls.length === 2 && fetched.length === 3)
      pass('adzuna.fetch() stops early on a short page (2 requests, 3 jobs)');
    else fail(`adzuna.fetch() made ${urls.length} requests, got ${fetched.length} jobs`);

    // --- fetch(): country validation --------------------------------------
    let badCountry = null;
    try {
      await adzuna.fetch({ provider: 'adzuna', country: 'usa' }, { fetchJson: async () => ({ results: [] }) });
    } catch (err) { badCountry = err; }
    if (badCountry && /unknown country/.test(badCountry.message))
      pass('adzuna.fetch() rejects unknown country codes ("usa" → error)');
    else fail(`adzuna.fetch() bad country → ${badCountry ? badCountry.message : 'no error'}`);
  } finally {
    if (savedId === undefined) delete process.env.ADZUNA_APP_ID; else process.env.ADZUNA_APP_ID = savedId;
    if (savedKey === undefined) delete process.env.ADZUNA_APP_KEY; else process.env.ADZUNA_APP_KEY = savedKey;
  }
} catch (err) {
  fail(`adzuna test crashed: ${err.message}`);
}
