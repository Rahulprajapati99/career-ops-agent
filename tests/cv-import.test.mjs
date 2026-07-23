// tests/cv-import.test.mjs — candidate extraction + profile sync (no network).
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';

console.log('\nCV import — cv-import.mjs');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'cv-import.mjs')).href);
  const { extractCandidateBasics, syncProfileFromCv } = mod;

  const cv = `# RAHUL PRAJAPATI\n\nQA Lead — Toronto\nEmail: rahul.connectx@gmail.com | 226-977-6971\nlinkedin.com/in/rahul-prajapati\n\n## Experience\n- Led QA at Acme.\n`;

  // --- extraction ---------------------------------------------------------
  const b = extractCandidateBasics(cv);
  if (b.full_name === 'Rahul Prajapati')
    pass('ALL-CAPS resume name is title-cased');
  else fail(`full_name = ${JSON.stringify(b.full_name)}`);
  if (b.email === 'rahul.connectx@gmail.com') pass('email extracted');
  else fail(`email = ${JSON.stringify(b.email)}`);
  if (b.phone === '226-977-6971') pass('phone extracted');
  else fail(`phone = ${JSON.stringify(b.phone)}`);
  if (b.linkedin === 'linkedin.com/in/rahul-prajapati') pass('linkedin extracted');
  else fail(`linkedin = ${JSON.stringify(b.linkedin)}`);
  const tagline = extractCandidateBasics('# Jane Doe | Product Leader\n');
  if (tagline.full_name === 'Jane Doe') pass('tagline after | is stripped from name');
  else fail(`tagline name = ${JSON.stringify(tagline.full_name)}`);

  // --- profile sync -------------------------------------------------------
  const tmp = mkdtempSync(join(tmpdir(), 'cvimport-'));
  try {
    const profilePath = join(tmp, 'profile.yml');
    writeFileSync(profilePath, [
      'candidate:',
      '  full_name: "Jane Smith"',
      '  email: "jane@example.com"',
      '  phone: "+1-555-0123"',
      '  location: "San Francisco, CA"',
      '  linkedin: "linkedin.com/in/janesmith"',
      '  portfolio_url: "https://janesmith.dev"',
      '#   # signature_name: "Jane Smith"',
      '',
    ].join('\n'));

    const updated = syncProfileFromCv(cv, profilePath);
    const out = readFileSync(profilePath, 'utf-8');
    if (out.includes('full_name: "Rahul Prajapati"') && out.includes('email: "rahul.connectx@gmail.com"'))
      pass('placeholders replaced with resume values');
    else fail(`profile after sync:\n${out}`);
    if (out.includes('portfolio_url: ""') && out.includes('location: ""'))
      pass('unextractable placeholders are blanked (no fake links leak)');
    else fail('placeholder portfolio/location not blanked');
    if (out.includes('#   # signature_name: "Jane Smith"'))
      pass('commented example lines are left untouched');
    else fail('comment line was modified');
    if (updated.length >= 4) pass(`sync reports updated keys (${updated.length})`);
    else fail(`updated = ${JSON.stringify(updated)}`);

    // Deliberate edits must never be clobbered.
    writeFileSync(profilePath, 'candidate:\n  full_name: "My Chosen Name"\n  email: "me@real.com"\n');
    const updated2 = syncProfileFromCv(cv, profilePath);
    const out2 = readFileSync(profilePath, 'utf-8');
    if (out2.includes('"My Chosen Name"') && out2.includes('me@real.com') && updated2.length === 0)
      pass('user-edited values are never overwritten');
    else fail(`user edits clobbered: ${out2}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
} catch (err) {
  fail(`cv-import test crashed: ${err.message}`);
}
