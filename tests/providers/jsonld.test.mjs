// tests/providers/jsonld.test.mjs — generic schema.org JSON-LD provider unit tests (no network).
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — jsonld');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/jsonld.mjs')).href);
  const jsonld = mod.default;
  const { normalizeJsonldJob, collectNodes } = mod;

  if (jsonld.id === 'jsonld') pass('jsonld.id is "jsonld"');
  else fail(`jsonld.id is ${JSON.stringify(jsonld.id)}`);

  // --- normalizeJsonldJob -------------------------------------------------
  const base = 'https://careers.example.com/jobs';
  const posting = {
    '@type': 'JobPosting',
    title: 'Data <em>Engineer</em>',
    url: '/jobs/data-engineer-42',
    hiringOrganization: { '@type': 'Organization', name: 'Example Corp' },
    jobLocation: { '@type': 'Place', address: { addressLocality: 'Austin', addressRegion: 'TX', addressCountry: 'US' } },
    description: '<p>Pipelines &amp; platforms</p>',
    datePosted: '2026-07-19',
  };
  const row = normalizeJsonldJob(posting, base);
  if (row && row.title === 'Data Engineer')
    pass('normalizeJsonldJob strips tags from title');
  else fail(`normalizeJsonldJob title = ${JSON.stringify(row?.title)}`);
  if (row && row.url === 'https://careers.example.com/jobs/data-engineer-42')
    pass('normalizeJsonldJob resolves relative url against the page URL');
  else fail(`normalizeJsonldJob url = ${JSON.stringify(row?.url)}`);
  if (row && row.company === 'Example Corp' && row.location === 'Austin, TX, US')
    pass('normalizeJsonldJob maps hiringOrganization + composed address');
  else fail(`normalizeJsonldJob row = ${JSON.stringify(row)}`);
  if (row && row.description === 'Pipelines & platforms' && row.postedAt === Date.parse('2026-07-19'))
    pass('normalizeJsonldJob maps description (entities decoded) and datePosted');
  else fail(`normalizeJsonldJob desc/postedAt = ${JSON.stringify([row?.description, row?.postedAt])}`);

  const remote = normalizeJsonldJob(
    { '@type': 'JobPosting', title: 'SRE', url: 'https://x.example/sre', jobLocationType: 'TELECOMMUTE' },
    base,
  );
  if (remote && remote.location === 'Remote')
    pass('normalizeJsonldJob maps TELECOMMUTE → "Remote"');
  else fail(`normalizeJsonldJob TELECOMMUTE location = ${JSON.stringify(remote?.location)}`);

  if (normalizeJsonldJob({ '@type': 'JobPosting', title: 'No URL Role' }, base) === null)
    pass('normalizeJsonldJob drops postings without their own url (dedup-key safety)');
  else fail('normalizeJsonldJob should drop postings without a url');
  if (normalizeJsonldJob({ '@type': 'Organization', name: 'Not a job' }, base) === null)
    pass('normalizeJsonldJob ignores non-JobPosting nodes');
  else fail('normalizeJsonldJob should ignore non-JobPosting nodes');
  const typeArr = normalizeJsonldJob({ '@type': ['Thing', 'JobPosting'], title: 'T', url: 'https://x.example/t' }, base);
  if (typeArr) pass('normalizeJsonldJob accepts array-form @type containing JobPosting');
  else fail('normalizeJsonldJob should accept array-form @type');

  // --- collectNodes: containers ------------------------------------------
  const graph = collectNodes({ '@graph': [{ '@type': 'JobPosting', title: 'A' }, { '@type': 'WebSite' }] });
  if (graph.some((n) => n.title === 'A')) pass('collectNodes unwraps @graph containers');
  else fail('collectNodes should unwrap @graph');
  const list = collectNodes({
    '@type': 'ItemList',
    itemListElement: [{ '@type': 'ListItem', item: { '@type': 'JobPosting', title: 'B' } }],
  });
  if (list.some((n) => n.title === 'B')) pass('collectNodes unwraps ItemList → ListItem.item');
  else fail('collectNodes should unwrap ItemList wrappers');

  // --- fetch(): end-to-end over mocked HTML -------------------------------
  const html = `<!doctype html><html><head>
    <script type="application/ld+json">{ "@type": "JobPosting", "title": "Backend Dev",
      "url": "https://careers.example.com/jobs/backend-dev",
      "hiringOrganization": { "name": "Example Corp" },
      "jobLocation": { "address": { "addressLocality": "Calgary", "addressCountry": "CA" } } }</script>
    <script type="application/ld+json">not valid json {{{</script>
    <script type="application/ld+json">{ "@graph": [ { "@type": "JobPosting", "title": "Frontend Dev",
      "url": "/jobs/frontend-dev" } ] }</script>
    </head><body></body></html>`;
  let capturedUrl = null;
  let capturedOpts = null;
  const jobs = await jsonld.fetch(
    { name: 'Example Corp Careers', provider: 'jsonld', careers_url: base },
    { fetchText: async (url, opts) => { capturedUrl = url; capturedOpts = opts; return html; } },
  );
  if (capturedUrl === base) pass('jsonld.fetch() requests the configured careers_url');
  else fail(`jsonld.fetch() requested ${JSON.stringify(capturedUrl)}`);
  if (capturedOpts && capturedOpts.redirect === 'error')
    pass('jsonld.fetch() passes redirect:"error" to fetchText (SSRF guard)');
  else fail(`jsonld.fetch() opts = ${JSON.stringify(capturedOpts)}`);
  if (jobs.length === 2)
    pass('jsonld.fetch() harvests 2 postings and tolerates the malformed block');
  else fail(`jsonld.fetch() returned ${jobs.length} jobs (expected 2)`);
  if (jobs[1]?.url === 'https://careers.example.com/jobs/frontend-dev')
    pass('jsonld.fetch() resolves relative urls from @graph postings');
  else fail(`jsonld.fetch() job[1].url = ${JSON.stringify(jobs[1]?.url)}`);
  if (jobs[1]?.company === 'Example Corp Careers')
    pass('jsonld.fetch() falls back to the entry name when the posting has no org');
  else fail(`jsonld.fetch() job[1].company = ${JSON.stringify(jobs[1]?.company)}`);

  // --- fetch(): config + protocol guards ----------------------------------
  let noUrl = null;
  try { await jsonld.fetch({ name: 'X', provider: 'jsonld' }, { fetchText: async () => '' }); }
  catch (err) { noUrl = err; }
  if (noUrl && /careers_url/.test(noUrl.message))
    pass('jsonld.fetch() fails loudly without a careers_url');
  else fail(`jsonld.fetch() without url → ${noUrl ? noUrl.message : 'no error'}`);
  let httpUrl = null;
  try { await jsonld.fetch({ name: 'X', provider: 'jsonld', careers_url: 'http://insecure.example/jobs' }, { fetchText: async () => '' }); }
  catch (err) { httpUrl = err; }
  if (httpUrl && /HTTPS/.test(httpUrl.message))
    pass('jsonld.fetch() rejects non-HTTPS pages');
  else fail(`jsonld.fetch() http url → ${httpUrl ? httpUrl.message : 'no error'}`);
} catch (err) {
  fail(`jsonld test crashed: ${err.message}`);
}
