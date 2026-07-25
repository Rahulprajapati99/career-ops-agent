// tests/jd-fetch.test.mjs — URL recognition + HTML flattening (no network).
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nJD fetch — jd-fetch.mjs');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'jd-fetch.mjs')).href);
  const {
    parseJobUrl, htmlToText, parseEmbeddedJobUrl, findEmbeddedBoardToken,
    looksLikeJd, flattenBrowserExtract,
  } = mod;

  // --- Ashby --------------------------------------------------------------
  const ashby = parseJobUrl('https://jobs.ashbyhq.com/absorblms/97c4bfb2-2d73-4cfb-9c18-bdb67a8ce011?utm_source=linkedinpaid');
  if (ashby && ashby.kind === 'ashby' && ashby.org === 'absorblms' && ashby.id === '97c4bfb2-2d73-4cfb-9c18-bdb67a8ce011')
    pass('parseJobUrl recognizes Ashby job URLs (org + uuid, query ignored)');
  else fail(`ashby parse = ${JSON.stringify(ashby)}`);
  const ashbyApp = parseJobUrl('https://jobs.ashbyhq.com/openai/11111111-2222-3333-4444-555555555555/application');
  if (ashbyApp && ashbyApp.id === '11111111-2222-3333-4444-555555555555')
    pass('parseJobUrl handles Ashby /application suffix');
  else fail(`ashby app parse = ${JSON.stringify(ashbyApp)}`);

  // --- Greenhouse ---------------------------------------------------------
  const gh = parseJobUrl('https://boards.greenhouse.io/cloudflare/jobs/8024889');
  if (gh && gh.kind === 'greenhouse' && gh.org === 'cloudflare' && gh.id === '8024889')
    pass('parseJobUrl recognizes boards.greenhouse.io/{org}/jobs/{id}');
  else fail(`greenhouse parse = ${JSON.stringify(gh)}`);
  const ghJid = parseJobUrl('https://job-boards.greenhouse.io/stripe?gh_jid=8064702');
  if (ghJid && ghJid.kind === 'greenhouse' && ghJid.org === 'stripe' && ghJid.id === '8064702')
    pass('parseJobUrl recognizes gh_jid query form on job-boards host');
  else fail(`gh_jid parse = ${JSON.stringify(ghJid)}`);

  // --- Lever --------------------------------------------------------------
  const lever = parseJobUrl('https://jobs.lever.co/wealthsimple/aaaabbbb-cccc-dddd-eeee-ffff00001111');
  if (lever && lever.kind === 'lever' && lever.org === 'wealthsimple')
    pass('parseJobUrl recognizes Lever job URLs');
  else fail(`lever parse = ${JSON.stringify(lever)}`);

  // --- non-ATS URLs fall through ------------------------------------------
  if (parseJobUrl('https://www.linkedin.com/jobs/view/123456') === null
      && parseJobUrl('https://example.com/careers') === null
      && parseJobUrl('not a url') === null)
    pass('parseJobUrl returns null for non-ATS / invalid URLs (browser fallback)');
  else fail('parseJobUrl should return null for non-ATS URLs');
  if (parseJobUrl('https://jobs.ashbyhq.com/onlyorg') === null)
    pass('parseJobUrl requires a uuid segment for Ashby');
  else fail('ashby without uuid should be null');

  // --- embedded boards (company-hosted page + ?gh_jid=) --------------------
  // Regression: boomi.com/boomi-jobs/?gh_jid=... fell through to the browser,
  // which read the marketing shell (the JD lives in a cross-origin iframe) and
  // handed a JD-less page to the evaluator → "missing Block A…G".
  const embedded = parseEmbeddedJobUrl('https://boomi.com/boomi-jobs/?gh_jid=5786913004');
  if (embedded && embedded.kind === 'greenhouse' && embedded.id === '5786913004')
    pass('parseEmbeddedJobUrl recognizes ?gh_jid= on a company-hosted page');
  else fail(`embedded gh parse = ${JSON.stringify(embedded)}`);

  const embeddedAshby = parseEmbeddedJobUrl('https://acme.com/careers?ashby_jid=97c4bfb2-2d73-4cfb-9c18-bdb67a8ce011');
  if (embeddedAshby && embeddedAshby.kind === 'ashby' && embeddedAshby.id === '97c4bfb2-2d73-4cfb-9c18-bdb67a8ce011')
    pass('parseEmbeddedJobUrl recognizes ?ashby_jid= on a company-hosted page');
  else fail(`embedded ashby parse = ${JSON.stringify(embeddedAshby)}`);

  if (parseEmbeddedJobUrl('https://job-boards.greenhouse.io/stripe?gh_jid=8064702') === null
      && parseEmbeddedJobUrl('https://example.com/careers') === null
      && parseEmbeddedJobUrl('https://example.com/careers?gh_jid=not-a-number') === null)
    pass('parseEmbeddedJobUrl defers to parseJobUrl for first-party ATS hosts');
  else fail('parseEmbeddedJobUrl should be null for first-party ATS / id-less URLs');

  const ghToken = findEmbeddedBoardToken(
    '<p><script src="https://boards.greenhouse.io/embed/job_board/js?for=boomilp"></script></p>',
    'greenhouse',
  );
  if (ghToken === 'boomilp') pass('findEmbeddedBoardToken reads the Greenhouse embed token (for=)');
  else fail(`greenhouse token = ${JSON.stringify(ghToken)}`);

  const ashbyToken = findEmbeddedBoardToken(
    '<script src="https://jobs.ashbyhq.com/acme-corp/embed?version=2"></script>', 'ashby',
  );
  if (ashbyToken === 'acme-corp') pass('findEmbeddedBoardToken reads the Ashby embed org');
  else fail(`ashby token = ${JSON.stringify(ashbyToken)}`);

  if (findEmbeddedBoardToken('<html><body>no board here</body></html>', 'greenhouse') === null)
    pass('findEmbeddedBoardToken returns null when the page has no embed');
  else fail('findEmbeddedBoardToken should be null without an embed');

  // --- JD quality gate ----------------------------------------------------
  const shell = `Boomi Unlock Possible. ${'Careers at Boomi. Search jobs. '.repeat(30)}`;
  if (!looksLikeJd(shell)) pass('looksLikeJd rejects a marketing shell page');
  else fail('looksLikeJd should reject page chrome');

  const realJd = `Senior Software Quality Engineer - AI
About the role: you will own test automation for our AI platform.
Responsibilities: design test plans, build CI coverage, partner with engineering.
Qualifications: 5+ years of experience in QA automation, Python, Playwright.
${'We value curiosity and ownership across the team. '.repeat(20)}`;
  if (looksLikeJd(realJd)) pass('looksLikeJd accepts a real posting');
  else fail('looksLikeJd should accept a real JD');

  if (!looksLikeJd('') && !looksLikeJd(null)) pass('looksLikeJd rejects empty input');
  else fail('looksLikeJd should reject empty input');

  // --- browser-extract JSON unwrapping ------------------------------------
  const flat = flattenBrowserExtract(JSON.stringify({
    url: 'https://acme.com/jobs/1', title: 'Staff Engineer', text: 'Responsibilities:\n- ship',
  }));
  if (flat.startsWith('Title: Staff Engineer') && flat.includes('URL: https://acme.com/jobs/1')
      && flat.includes('Responsibilities:') && !flat.includes('"text"'))
    pass('flattenBrowserExtract turns browser-extract JSON into prose');
  else fail(`flatten = ${JSON.stringify(flat)}`);

  if (flattenBrowserExtract('plain text jd') === 'plain text jd'
      && flattenBrowserExtract('{not json') === '{not json')
    pass('flattenBrowserExtract passes non-JSON through unchanged');
  else fail('flattenBrowserExtract should pass plain text through');

  // --- htmlToText ---------------------------------------------------------
  const text = htmlToText('<h2>About</h2><p>Build &amp; ship.</p><ul><li>Own QA</li><li>Automate</li></ul>');
  if (text.includes('Build & ship.') && text.includes('- Own QA') && text.includes('- Automate') && !/[<>]/.test(text))
    pass('htmlToText flattens blocks, bullets lists, decodes entities, strips tags');
  else fail(`htmlToText = ${JSON.stringify(text)}`);
  if (htmlToText('a<br>b<br/>c').split('\n').length === 3)
    pass('htmlToText converts <br> variants to newlines');
  else fail(`br handling = ${JSON.stringify(htmlToText('a<br>b<br/>c'))}`);
} catch (err) {
  fail(`jd-fetch test crashed: ${err.message}`);
}
