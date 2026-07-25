// tests/profile-fields.test.mjs — the contact fields printed on every CV.
//
// These values are copied verbatim into tailored CVs and cover letters, so a
// wrong one is visible to employers, and a value belonging to ANOTHER family
// member is a privacy leak. Hence the strictness here.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';

console.log('\nProfile contact fields — lib/profile-fields.mjs');

const PROFILE = `# profile.yml — your details
candidate:
  full_name: "Jane Smith"          # CUSTOMIZE
  email: "jane@example.com"
  phone: ""
  linkedin: "linkedin.com/in/janesmith"
  portfolio_url: "https://janesmith.dev"

targets:
  titles:
    - QA Engineer

integrations:
  serpapi_key: "EXAMPLEfakekey0000000000"
`;

try {
  const { FIELDS, resolveField, normalizeValue, readCandidate, writeCandidateField } =
    await import(pathToFileURL(join(ROOT, 'lib', 'profile-fields.mjs')).href);

  // --- field resolution ----------------------------------------------------
  if (resolveField('linkedin') === 'linkedin' && resolveField('LinkedIn') === 'linkedin'
      && resolveField('portfolio') === 'portfolio_url' && resolveField('name') === 'full_name'
      && resolveField('website') === 'portfolio_url')
    pass('resolveField handles canonical names, case, and the aliases people type');
  else fail('resolveField wrong');

  if (resolveField('photo') === null && resolveField('nonsense') === null)
    pass('unknown/non-contact fields are refused (a typo cannot create a dead key)');
  else fail('resolveField accepted something it should not');

  // --- the real fix: HR's LinkedIn -----------------------------------------
  const li = normalizeValue('linkedin', 'https://www.linkedin.com/in/zoya-saiyed/');
  if (li.ok && li.value === 'https://www.linkedin.com/in/zoya-saiyed') pass(`the reported LinkedIn normalizes cleanly (${li.value})`);
  else fail(`linkedin normalize = ${JSON.stringify(li)}`);

  // Bare form gets a scheme so it is clickable on the CV.
  const bare = normalizeValue('linkedin', 'linkedin.com/in/zoya-saiyed');
  if (bare.ok && bare.value === 'https://linkedin.com/in/zoya-saiyed') pass('a scheme-less LinkedIn is upgraded to https://');
  else fail(`bare linkedin = ${JSON.stringify(bare)}`);

  // Tracking noise must not end up printed on a CV.
  const noisy = normalizeValue('linkedin', 'https://www.linkedin.com/in/zoya-saiyed/?originalSubdomain=ca&trk=nav#top');
  if (noisy.ok && noisy.value === 'https://www.linkedin.com/in/zoya-saiyed') pass('query/hash tracking is stripped from the URL');
  else fail(`noisy linkedin = ${JSON.stringify(noisy)}`);

  // A "LinkedIn" pointing elsewhere is a mistake worth catching before print.
  if (!normalizeValue('linkedin', 'https://example.com/in/someone').ok) pass('a LinkedIn field rejects a non-LinkedIn host');
  else fail('wrong host accepted for linkedin');
  if (!normalizeValue('github', 'https://gitlab.com/someone').ok) pass('a GitHub field rejects a non-GitHub host');
  else fail('wrong host accepted for github');

  // Portfolio is any site, so no host restriction.
  if (normalizeValue('portfolio_url', 'zoya-saiyed.com').ok) pass('portfolio accepts any host');
  else fail('portfolio rejected a valid site');

  // --- validation ----------------------------------------------------------
  if (normalizeValue('email', 'zoya@example.com').ok && !normalizeValue('email', 'not-an-email').ok)
    pass('email is validated');
  else fail('email validation wrong');

  if (normalizeValue('phone', '+1 (226) 555-0100').ok && !normalizeValue('phone', 'call me').ok)
    pass('phone is validated');
  else fail('phone validation wrong');

  for (const bad of ['', '   ', 'a\nb', 'x'.repeat(500), 'foo `whoami`', 'a; rm -rf /', 'a$(id)', 'a|b']) {
    if (normalizeValue('full_name', bad).ok) { fail(`unsafe/invalid value accepted: ${JSON.stringify(bad)}`); break; }
  }
  pass('empty, multi-line, over-long, and shell-metacharacter values are refused');

  // Chat wrapping is stripped, as elsewhere in the bot.
  if (normalizeValue('portfolio_url', '<zoya-saiyed.com>').ok) pass('angle-bracket wrapping is stripped');
  else fail('wrapped value refused');

  // --- writing -------------------------------------------------------------
  const dir = mkdtempSync(join(tmpdir(), 'prof-'));
  const p = join(dir, 'profile.yml');
  writeFileSync(p, PROFILE);

  if (readCandidate(p).linkedin === 'linkedin.com/in/janesmith') pass('readCandidate reads the existing values');
  else fail(`readCandidate = ${JSON.stringify(readCandidate(p))}`);

  const w = writeCandidateField(p, 'linkedin', 'https://www.linkedin.com/in/zoya-saiyed');
  if (w.changed && w.previous === 'linkedin.com/in/janesmith') pass('writeCandidateField reports what it replaced');
  else fail(`write result = ${JSON.stringify(w)}`);

  const after = readFileSync(p, 'utf-8');
  if (readCandidate(p).linkedin === 'https://www.linkedin.com/in/zoya-saiyed') pass('the new value is what the tooling now reads');
  else fail('value did not persist');

  // The file is the user's documentation — it must survive intact.
  if (/# profile\.yml — your details/.test(after) && /# CUSTOMIZE/.test(after) && /QA Engineer/.test(after))
    pass('comments and unrelated blocks survive the edit');
  else fail('the edit damaged the rest of profile.yml');

  if (/serpapi_key: "EXAMPLEfakekey0000000000"/.test(after)) pass('the integrations block is untouched');
  else fail('integrations were disturbed');

  // Only the candidate block may be edited, even when another block shares a key.
  writeFileSync(p, `candidate:\n  linkedin: "old"\n\nother:\n  linkedin: "do-not-touch"\n`);
  writeCandidateField(p, 'linkedin', 'https://www.linkedin.com/in/zoya-saiyed');
  const scoped = readFileSync(p, 'utf-8');
  if (/other:\s*\n\s*linkedin: "do-not-touch"/.test(scoped)) pass('a same-named key in another block is left alone');
  else fail(`scoping failed:\n${scoped}`);

  // A field absent from the block gets added rather than silently dropped.
  writeFileSync(p, `candidate:\n  full_name: "Zoya"\n`);
  writeCandidateField(p, 'portfolio_url', 'https://zoya-saiyed.com');
  if (readCandidate(p).portfolio_url === 'https://zoya-saiyed.com') pass('a missing field is inserted into the candidate block');
  else fail('insert failed');

  // Idempotent: re-setting the same value is a no-op.
  if (writeCandidateField(p, 'portfolio_url', 'https://zoya-saiyed.com').changed === false)
    pass('re-setting the same value reports no change');
  else fail('needless rewrite');

  // --- the systemic bug: no hardcoded personal data in the tailor prompt ---
  const tailor = readFileSync(join(ROOT, 'gemini-tailor.mjs'), 'utf-8');
  if (!/rahulprajapati99\.vercel\.app/.test(tailor))
    pass('gemini-tailor no longer hardcodes one person\'s portfolio into every CV');
  else fail('the tailor prompt still pins a specific portfolio URL — every user gets it');

  if (/NEVER reuse a URL|NEVER invent one/i.test(tailor))
    pass('the prompt tells the model to take contact details only from this user');
  else fail('the prompt lost its contact-provenance rule');
} catch (err) {
  fail(`profile-fields test crashed: ${err.message}`);
}
