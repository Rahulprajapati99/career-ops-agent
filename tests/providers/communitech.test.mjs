// tests/providers/communitech.test.mjs — Waterloo-region tech board (no network).
//
// Auto-discovered by test-all.mjs. All fixtures mirror the live payload shape
// measured 2026-07-25: cents-based salary with currency+period, a unix-seconds
// createdAt, a workMode enum, and the location frequently present ONLY inside a
// parenthesised title suffix.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — communitech');

/** Build a __NEXT_DATA__ page around a postings array. */
const page = (found) => `<!doctype html><html><body>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: { pageProps: { initialState: { jobs: { found } } } },
})}</script></body></html>`;

const JOB = {
  id: 87586547,
  title: 'Senior QA Engineer (Toronto, ON, CA, M5H 0A9)',
  url: 'https://careers.example.ca/job/12345',
  organization: { name: 'Zafin', slug: 'zafin' },
  compensationPublic: true,
  compensationAmountMinCents: 8000000,
  compensationAmountMaxCents: 12000000,
  compensationCurrency: 'CAD',
  compensationPeriod: 'year',
  compensationOffersEquity: false,
  createdAt: 1784988477,
  workMode: 'on_site',
  seniority: 'senior',
  skills: ['Selenium', 'Playwright'],
  locations: [],
  searchableLocations: [],
  locationDetails: [],
};

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers', 'communitech.mjs')).href);
  const { default: prov, extractNextData, postingsOf, resolveQueries, resolveMaxJobs,
    searchUrl, formatCompensation, extractLocation, normalizeCommunitechJob } = mod;

  // --- identity + detect ---------------------------------------------------
  if (prov.id === 'communitech') pass('id is "communitech"');
  else fail(`id = ${prov.id}`);

  if (prov.detect({ careers_url: 'https://www1.communitech.ca/jobs' })
      && prov.detect({ careers_url: 'https://communitech.ca/jobs?q=qa' })
      && !prov.detect({ careers_url: 'https://example.com/jobs' })
      && !prov.detect({}))
    pass('detect() matches the board (with/without www1) and nothing else');
  else fail('detect() wrong');

  // --- payload extraction --------------------------------------------------
  if (postingsOf(extractNextData(page([JOB]))).length === 1) pass('extractNextData + postingsOf read the postings array');
  else fail('payload extraction failed');

  if (extractNextData('<html>no script</html>') === null && extractNextData('<script id="__NEXT_DATA__">{bad json</script>') === null)
    pass('a missing or malformed payload yields null instead of throwing');
  else fail('bad payload not handled');

  if (postingsOf({}).length === 0 && postingsOf(null).length === 0) pass('postingsOf tolerates an unexpected shape');
  else fail('postingsOf threw or guessed');

  // --- queries + caps ------------------------------------------------------
  if (resolveQueries({}).join('|') === '' && resolveQueries({ queries: ['qa', 'QA', ' test '] }).join('|') === 'qa|test')
    pass('resolveQueries dedupes case-insensitively and defaults to one unfiltered request');
  else fail(`resolveQueries = ${JSON.stringify(resolveQueries({ queries: ['qa', 'QA', ' test '] }))}`);

  if (resolveQueries({ queries: 'quality assurance' })[0] === 'quality assurance') pass('a single string query is accepted');
  else fail('string query not handled');

  if (resolveMaxJobs({}) === 200 && resolveMaxJobs({ max_jobs: 5 }) === 5 && resolveMaxJobs({ max_jobs: 99999 }) === 1000
      && resolveMaxJobs({ max_jobs: -1 }) === 200)
    pass('max_jobs defaults, honours a value, and is hard-capped');
  else fail(`resolveMaxJobs = ${resolveMaxJobs({ max_jobs: 99999 })}`);

  if (searchUrl('quality assurance').includes('q=quality+assurance') && !searchUrl('').includes('q='))
    pass('searchUrl encodes the term and omits q= when empty');
  else fail(`searchUrl = ${searchUrl('quality assurance')}`);

  // --- salary (cents → readable) ------------------------------------------
  if (formatCompensation(JOB) === 'CAD 80,000 - 120,000 per year') pass('salary formatted from cents with currency + period');
  else fail(`compensation = "${formatCompensation(JOB)}"`);

  // An employer that withheld pay must never have a figure invented for it.
  if (formatCompensation({ ...JOB, compensationPublic: false }) === '') pass('non-public compensation yields no figure');
  else fail('private salary leaked');

  if (formatCompensation({ ...JOB, compensationAmountMaxCents: 8000000 }) === 'CAD 80,000 per year')
    pass('a single-value range collapses to one figure');
  else fail(`collapsed range = "${formatCompensation({ ...JOB, compensationAmountMaxCents: 8000000 })}"`);

  if (formatCompensation({ compensationPublic: true }) === '' && formatCompensation(null) === '')
    pass('missing salary fields yield an empty string');
  else fail('empty salary mishandled');

  // --- location ------------------------------------------------------------
  if (extractLocation(JOB) === 'Toronto, ON, CA') pass('location parsed from the title suffix, postal code dropped');
  else fail(`location = "${extractLocation(JOB)}"`);

  if (extractLocation({ ...JOB, locations: ['Waterloo, ON, Canada'] }) === 'Waterloo, ON, Canada')
    pass('structured locations win over the title suffix');
  else fail(`structured location = "${extractLocation({ ...JOB, locations: ['Waterloo, ON, Canada'] })}"`);

  // geo-policy ranks on the location string, so remote must be visible in it.
  if (/Remote/.test(extractLocation({ ...JOB, workMode: 'remote' }))) pass('remote work mode surfaces in the location (geo-policy reads it)');
  else fail(`remote location = "${extractLocation({ ...JOB, workMode: 'remote' })}"`);

  if (extractLocation({ title: 'QA Engineer', workMode: 'on_site' }) === '') pass('no location anywhere yields empty, not a guess');
  else fail('location invented');

  // --- normalization -------------------------------------------------------
  const n = normalizeCommunitechJob(JOB, 'Communitech');
  if (n && n.title === 'Senior QA Engineer' && n.company === 'Zafin' && n.url === JOB.url)
    pass('normalize maps title/company/url (location suffix stripped from title)');
  else fail(`normalized = ${JSON.stringify(n)}`);

  if (n.postedAt === 1784988477 * 1000) pass('createdAt (unix seconds) converted to epoch ms');
  else fail(`postedAt = ${n.postedAt}`);

  if (/Seniority: senior/.test(n.description) && /Selenium/.test(n.description))
    pass('description carries seniority, work mode and skills');
  else fail(`description = ${JSON.stringify(n.description)}`);

  // A sentinel or millisecond createdAt must not become a nonsense date.
  if (normalizeCommunitechJob({ ...JOB, createdAt: 0 }).postedAt === undefined
      && normalizeCommunitechJob({ ...JOB, createdAt: 1784988477000 }).postedAt === undefined)
    pass('out-of-range createdAt is ignored rather than dated wrongly');
  else fail('bad createdAt accepted');

  // The url is the dedup key and goes into the pipeline: it must be usable.
  for (const bad of ['', 'javascript:alert(1)', 'not a url', '/relative/path']) {
    if (normalizeCommunitechJob({ ...JOB, url: bad }) !== null) { fail(`unusable url accepted: ${JSON.stringify(bad)}`); break; }
  }
  pass('a missing, relative, or non-http url drops the posting');

  // Employer career pages live on other hosts, so the url must NOT be host-locked.
  if (normalizeCommunitechJob({ ...JOB, url: 'https://careers.deloitte.ca/job/9' })?.url === 'https://careers.deloitte.ca/job/9')
    pass('an off-site employer career URL is kept (host-locking would drop every row)');
  else fail('off-site employer url rejected');

  if (normalizeCommunitechJob({ ...JOB, title: '   ' }) === null && normalizeCommunitechJob(null) === null)
    pass('a titleless or absent posting is dropped');
  else fail('empty posting accepted');

  if (normalizeCommunitechJob({ ...JOB, organization: null }, 'Fallback Co').company === 'Fallback Co')
    pass('company falls back to the entry name when the org is missing');
  else fail('company fallback wrong');

  // --- fetch() behaviour ---------------------------------------------------
  const ctx = (map) => ({ fetchText: async (u) => { if (!(u in map)) throw new Error('unexpected url ' + u); return map[u]; } });

  const two = { ...JOB, id: 2, url: 'https://careers.example.ca/job/2', title: 'QA Lead (Waterloo, ON, CA)' };
  const jobs = await prov.fetch({ name: 'Communitech', queries: ['qa'] }, ctx({ [searchUrl('qa')]: page([JOB, two]) }));
  if (jobs.length === 2) pass('fetch() returns the postings from a search');
  else fail(`fetch returned ${jobs.length}`);

  // The same posting surfacing under two search terms must appear once.
  const deduped = await prov.fetch({ queries: ['qa', 'test'] }, ctx({
    [searchUrl('qa')]: page([JOB]),
    [searchUrl('test')]: page([JOB, two]),
  }));
  if (deduped.length === 2) pass('fetch() dedupes the same posting across queries');
  else fail(`dedup produced ${deduped.length}`);

  // One failing query must not lose the others.
  const partial = await prov.fetch({ queries: ['qa', 'boom'] }, {
    fetchText: async (u) => { if (u === searchUrl('boom')) throw new Error('503'); return page([JOB]); },
  });
  if (partial.length === 1) pass('fetch() keeps results when one query fails');
  else fail(`partial fetch returned ${partial.length}`);

  // Every query failing means the source is broken — that must be loud.
  let threw = false;
  try { await prov.fetch({ queries: ['a', 'b'] }, { fetchText: async () => { throw new Error('down'); } }); }
  catch { threw = true; }
  if (threw) pass('fetch() throws when every query fails (no silent empty scan)');
  else fail('total failure reported as empty');

  // A layout change (no payload) is also a failure, not an empty board.
  let threw2 = false;
  try { await prov.fetch({ queries: ['qa'] }, ctx({ [searchUrl('qa')]: '<html>redesigned</html>' })); }
  catch { threw2 = true; }
  if (threw2) pass('fetch() throws when the payload cannot be read at all');
  else fail('unreadable payload reported as empty');

  const capped = await prov.fetch({ queries: ['qa'], max_jobs: 1 }, ctx({ [searchUrl('qa')]: page([JOB, two]) }));
  if (capped.length === 1) pass('fetch() honours max_jobs');
  else fail(`cap produced ${capped.length}`);

  // SSRF guard: the board request must refuse a server-side redirect.
  let sawRedirectGuard = false;
  await prov.fetch({ queries: ['qa'] }, {
    fetchText: async (u, opts) => { sawRedirectGuard = opts?.redirect === 'error'; return page([JOB]); },
  });
  if (sawRedirectGuard) pass('fetch() passes redirect:"error" (SSRF guard)');
  else fail('redirect guard missing');
} catch (err) {
  fail(`communitech test crashed: ${err.message}`);
}
