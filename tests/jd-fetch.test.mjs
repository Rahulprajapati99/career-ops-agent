// tests/jd-fetch.test.mjs — URL recognition + HTML flattening (no network).
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nJD fetch — jd-fetch.mjs');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'jd-fetch.mjs')).href);
  const { parseJobUrl, htmlToText } = mod;

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
