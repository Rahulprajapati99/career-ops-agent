// tests/providers/ycombinator.test.mjs — YC provider (YC's own public jobs
// board, Inertia data-page payload). Auto-discovered by test-all.mjs.
// No network: every fetch goes through a stub ctx.fetchText routed by URL.
import { pass, fail, ROOT, captureConsoleErrors } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — ycombinator');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/ycombinator.mjs')).href);
  const yc = mod.default;
  const {
    ROLE_PATHS, roleUrl, resolveRoles, resolveMaxJobs,
    extractPageData, parseRelativeAge, absolutePostingUrl, normalizeYcJob,
  } = mod;

  if (yc.id === 'ycombinator') pass('ycombinator.id is "ycombinator"');
  else fail(`ycombinator.id is ${JSON.stringify(yc.id)}`);

  // ── Helpers ───────────────────────────────────────────────────────

  if (roleUrl('eng') === 'https://www.ycombinator.com/jobs/role/software-engineer' && roleUrl('nope') === null)
    pass('roleUrl() maps a role category to its server-rendered path');
  else fail(`roleUrl('eng') = ${JSON.stringify(roleUrl('eng'))}`);

  if (Object.keys(ROLE_PATHS).length === 11 && ROLE_PATHS.legal === 'legal' && ROLE_PATHS.product === 'product-manager')
    pass('ROLE_PATHS covers all 11 YC role categories');
  else fail(`ROLE_PATHS = ${JSON.stringify(ROLE_PATHS)}`);

  if (resolveRoles({}).length === 11 && resolveRoles({ roles: 'eng' }).length === 11)
    pass('resolveRoles() defaults to every role category');
  else fail(`resolveRoles({}) = ${JSON.stringify(resolveRoles({}))}`);

  if (JSON.stringify(resolveRoles({ roles: [' ENG ', 'bogus', 'eng', 'design'] })) === '["eng","design"]')
    pass('resolveRoles() normalizes case, drops unknown roles, dedups, keeps order');
  else fail(`resolveRoles() = ${JSON.stringify(resolveRoles({ roles: [' ENG ', 'bogus', 'eng', 'design'] }))}`);

  if (resolveRoles({ roles: ['nope'] }).length === 11)
    pass('resolveRoles() falls back to all roles when nothing valid remains');
  else fail('resolveRoles() should fall back when every role is unknown');

  if (resolveMaxJobs({}) === 500 && resolveMaxJobs({ max_jobs: 40 }) === 40
      && resolveMaxJobs({ max_jobs: 99999 }) === 2000 && resolveMaxJobs({ max_jobs: 0 }) === 500)
    pass('resolveMaxJobs() defaults to 500, honors overrides, caps at 2000');
  else fail(`resolveMaxJobs() = ${resolveMaxJobs({})}/${resolveMaxJobs({ max_jobs: 99999 })}`);

  const NOW = 1_800_000_000_000;
  if (parseRelativeAge('16 days', NOW) === NOW - 16 * 86400e3
      && parseRelativeAge('20 hours', NOW) === NOW - 20 * 3600e3
      && parseRelativeAge('3 months', NOW) === NOW - 3 * 2592000e3)
    pass('parseRelativeAge() converts YC relative ages to epoch ms');
  else fail(`parseRelativeAge('16 days') = ${parseRelativeAge('16 days', NOW)}`);

  if (parseRelativeAge('', NOW) === undefined && parseRelativeAge(null, NOW) === undefined
      && parseRelativeAge('just now', NOW) === undefined)
    pass('parseRelativeAge() returns undefined for unparseable ages (never "now")');
  else fail('parseRelativeAge() should return undefined for unparseable input');

  // URL host-locking — the url is the dedup key and gets written to the pipeline.
  if (absolutePostingUrl('/companies/acme/jobs/x1') === 'https://www.ycombinator.com/companies/acme/jobs/x1')
    pass('absolutePostingUrl() resolves site-relative posting URLs against YC');
  else fail(`absolutePostingUrl('/companies/…') = ${absolutePostingUrl('/companies/acme/jobs/x1')}`);

  const offSite = ['https://evil.com/companies/x', 'http://www.ycombinator.com/jobs/x', '//evil.com/x', '', null];
  if (offSite.every((u) => absolutePostingUrl(u) === null))
    pass('absolutePostingUrl() rejects off-host, non-https, and empty URLs');
  else fail(`absolutePostingUrl() accepted an off-site URL: ${JSON.stringify(offSite.map(absolutePostingUrl))}`);

  // ── Payload extraction ────────────────────────────────────────────

  const payload = { props: { jobCategory: 'eng', jobPostings: [] } };
  const escaped = JSON.stringify(payload).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const html = `<html><body><div id="app" data-page="${escaped}"></div></body></html>`;

  const got = extractPageData(html);
  if (got && got.props && got.props.jobCategory === 'eng')
    pass('extractPageData() parses the HTML-escaped Inertia data-page payload');
  else fail(`extractPageData() = ${JSON.stringify(got)}`);

  if (extractPageData('<html>no attribute here</html>') === null
      && extractPageData('<div data-page="not json"></div>') === null
      && extractPageData(null) === null)
    pass('extractPageData() returns null for a missing attribute or unparseable JSON');
  else fail('extractPageData() should return null when the payload is unreadable');

  // ── Normalization ─────────────────────────────────────────────────

  const rawJob = {
    title: '  Senior QA Engineer  ',
    url: '/companies/acme/jobs/abc-senior-qa-engineer',
    location: 'San Francisco, CA, US / Remote (US)',
    type: 'Full-time',
    salaryRange: '$150K - $240K',
    visa: 'Will sponsor',
    skills: ['Playwright', ' Python '],
    companyName: 'Acme',
    companyBatchName: 'W22',
    companyOneLiner: 'Testing infrastructure for robots.',
    createdAt: '16 days',
  };
  const norm = normalizeYcJob(rawJob, 'YC', NOW);

  if (norm?.title === 'Senior QA Engineer'
      && norm?.url === 'https://www.ycombinator.com/companies/acme/jobs/abc-senior-qa-engineer'
      && norm?.company === 'Acme'
      && norm?.location === 'San Francisco, CA, US / Remote (US)')
    pass('normalizeYcJob() maps title/url/company/location into the canonical shape');
  else fail(`normalizeYcJob() = ${JSON.stringify(norm)}`);

  if (norm?.postedAt === NOW - 16 * 86400e3)
    pass('normalizeYcJob() converts createdAt into postedAt (epoch ms)');
  else fail(`normalizeYcJob().postedAt = ${norm?.postedAt}`);

  if (norm?.description?.includes('YC W22 · Full-time · $150K - $240K · Visa: Will sponsor')
      && norm.description.includes('Skills: Playwright, Python')
      && norm.description.includes('Testing infrastructure for robots.'))
    pass('normalizeYcJob() builds the description from list-payload fields only');
  else fail(`normalizeYcJob().description = ${JSON.stringify(norm?.description)}`);

  if (normalizeYcJob({ title: '', url: '/companies/a/jobs/b' }, 'YC') === null
      && normalizeYcJob({ title: 'X', url: 'https://evil.com/j' }, 'YC') === null
      && normalizeYcJob(null, 'YC') === null)
    pass('normalizeYcJob() drops postings with no title or an unusable URL');
  else fail('normalizeYcJob() should drop title-less / off-host postings');

  if (normalizeYcJob({ title: 'X', url: '/companies/a/jobs/b' }, 'Fallback Co')?.company === 'Fallback Co')
    pass('normalizeYcJob() falls back to entry.name when companyName is absent');
  else fail('normalizeYcJob() company fallback failed');

  // ── fetch() ───────────────────────────────────────────────────────

  const page = (category, jobs) => {
    const esc = JSON.stringify({ props: { jobCategory: category, jobPostings: jobs } })
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return `<div data-page="${esc}"></div>`;
  };
  const job = (id, extra = {}) => ({
    title: `Role ${id}`, url: `/companies/c${id}/jobs/${id}`, companyName: `Co${id}`,
    location: 'Remote', createdAt: '2 days', ...extra,
  });

  const calls = [];
  const stub = {
    fetchText: async (url, opts) => {
      calls.push({ url, opts });
      if (url.endsWith('/software-engineer')) return page('eng', [job('a'), job('b')]);
      if (url.endsWith('/design')) return page('design', [job('c')]);
      // Every other role path falls back to the eng list, exactly like the live
      // site does for a path it doesn't recognize.
      return page('eng', [job('a'), job('b')]);
    },
  };

  const jobs = await yc.fetch({ name: 'Y Combinator', provider: 'ycombinator' }, stub);

  if (calls.length === 11)
    pass('ycombinator.fetch() requests one page per role category');
  else fail(`ycombinator.fetch() made ${calls.length} requests (expected 11)`);

  if (calls.every((c) => c.opts && c.opts.redirect === 'error'))
    pass('ycombinator.fetch() passes redirect:"error" on every request (SSRF guard)');
  else fail('ycombinator.fetch() made a request without redirect:"error"');

  if (calls.every((c) => c.url.startsWith('https://www.ycombinator.com/jobs/role/')))
    pass('ycombinator.fetch() only ever requests YC role paths');
  else fail(`ycombinator.fetch() requested ${JSON.stringify(calls.map((c) => c.url))}`);

  // eng contributed 2, design 1; the 9 mismatched fallbacks contribute nothing.
  if (jobs.length === 3)
    pass('ycombinator.fetch() ignores role pages that serve a different category');
  else fail(`ycombinator.fetch() returned ${jobs.length} jobs (expected 3): ${JSON.stringify(jobs.map((j) => j.title))}`);

  if (new Set(jobs.map((j) => j.url)).size === jobs.length)
    pass('ycombinator.fetch() dedups postings that appear under multiple roles');
  else fail('ycombinator.fetch() returned duplicate posting URLs');

  // roles: subset
  const subsetCalls = [];
  await yc.fetch({ name: 'YC', roles: ['design'] }, {
    fetchText: async (url) => { subsetCalls.push(url); return page('design', [job('c')]); },
  });
  if (subsetCalls.length === 1 && subsetCalls[0].endsWith('/design'))
    pass('ycombinator.fetch() honors a roles: subset');
  else fail(`ycombinator.fetch() roles subset requested ${JSON.stringify(subsetCalls)}`);

  // max_jobs cap stops the walk early.
  const capped = await yc.fetch({ name: 'YC', max_jobs: 1 }, stub);
  if (capped.length === 1)
    pass('ycombinator.fetch() respects the max_jobs cap');
  else fail(`ycombinator.fetch() max_jobs=1 returned ${capped.length} jobs`);

  // A single failing role list is survivable and reported, not fatal.
  const { result: partial, errors } = await captureConsoleErrors(() => yc.fetch({ name: 'YC', roles: ['eng', 'design'] }, {
    fetchText: async (url) => {
      if (url.endsWith('/design')) throw new Error('HTTP 503 Service Unavailable');
      return page('eng', [job('a')]);
    },
  }));
  if (partial.length === 1 && errors.some((e) => String(e).includes('design list failed')))
    pass('ycombinator.fetch() survives one role list failing and warns about it');
  else fail(`ycombinator.fetch() partial-failure = ${partial.length} jobs, errors ${JSON.stringify(errors)}`);

  // Total failure is loud — a silent 0 would look like "no new jobs" forever.
  let threwAll = false;
  try {
    await yc.fetch({ name: 'YC', roles: ['eng'] }, { fetchText: async () => { throw new Error('network down'); } });
  } catch (e) {
    threwAll = /no role list could be read/.test(e.message);
  }
  if (threwAll) pass('ycombinator.fetch() throws when no role list can be read');
  else fail('ycombinator.fetch() should throw when every role list fails');

  // Layout change (no data-page) is also loud rather than silently empty.
  let threwLayout = false;
  const { errors: layoutErrors } = await captureConsoleErrors(async () => {
    try {
      await yc.fetch({ name: 'YC', roles: ['eng'] }, { fetchText: async () => '<html>redesigned</html>' });
    } catch (e) {
      threwLayout = /no role list could be read/.test(e.message);
    }
  });
  if (threwLayout && layoutErrors.some((e) => String(e).includes('layout may have changed')))
    pass('ycombinator.fetch() reports a YC layout change instead of returning 0 jobs');
  else fail(`ycombinator.fetch() layout-change handling: threw=${threwLayout}, errors=${JSON.stringify(layoutErrors)}`);

  // detect() lets a portals entry wire in by careers_url alone.
  if (yc.detect({ careers_url: 'https://www.ycombinator.com/jobs' })
      && yc.detect({ careers_url: 'https://ycombinator.com/jobs/role/design' })
      && !yc.detect({ careers_url: 'https://www.ycombinator.com/companies' })
      && !yc.detect({ careers_url: 'https://evil.com/ycombinator.com/jobs' })
      && !yc.detect({}))
    pass('ycombinator.detect() claims YC /jobs URLs only');
  else fail('ycombinator.detect() matched the wrong set of URLs');

} catch (e) {
  fail(`ycombinator provider tests crashed: ${e.message}`);
}
