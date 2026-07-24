// tests/gemini-email.test.mjs — outreach email signature block (no network).
//
// Guards a reported miss: the portfolio link was absent from the drafted
// signature. The line is only emitted when the profile actually carries the
// field, so this pins down which field names count and that every link comes
// out clickable.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { readFileSync } from 'fs';

console.log('\nOutreach email signature — gemini-email.mjs');

try {
  const { buildSignatureLines, asUrl } = await import(pathToFileURL(join(ROOT, 'gemini-email.mjs')).href);

  const cand = {
    full_name: 'Alex Doe',
    email: 'alex@example.com',
    phone: '555-0100',
    linkedin: 'linkedin.com/in/alex-doe',
    github: 'github.com/alexdoe',
    portfolio_url: 'alexdoe.example.app',
  };
  const lines = buildSignatureLines(cand);

  const portfolioLine = lines.find((l) => l.startsWith('Portfolio:'));
  if (portfolioLine) pass(`portfolio line present: "${portfolioLine}"`);
  else fail(`no Portfolio line in signature: ${JSON.stringify(lines)}`);

  // Bare domains do not auto-link in Gmail/Outlook — the whole point of the line.
  if (portfolioLine === 'Portfolio: https://alexdoe.example.app') pass('bare domain upgraded to a clickable https:// URL');
  else fail(`portfolio not normalized: ${portfolioLine}`);

  if (asUrl('https://alexdoe.example.app/') === 'https://alexdoe.example.app/') pass('an already-absolute URL is left untouched');
  else fail('asUrl double-prefixed an absolute URL');

  if (lines.some((l) => l === 'https://linkedin.com/in/alex-doe')
    && lines.some((l) => l === 'GitHub: https://github.com/alexdoe'))
    pass('LinkedIn and GitHub are clickable too');
  else fail(`links not normalized: ${JSON.stringify(lines)}`);

  // A profile may spell the field differently; none of them should vanish.
  for (const field of ['portfolio_url', 'portfolio', 'website']) {
    const out = buildSignatureLines({ full_name: 'A', [field]: 'me.example.app' });
    if (out.includes('Portfolio: https://me.example.app')) pass(`portfolio read from "${field}"`);
    else fail(`portfolio under "${field}" was dropped`);
  }

  // No portfolio configured → no empty "Portfolio:" line dangling in the email.
  const bare = buildSignatureLines({ full_name: 'A', email: 'a@b.co' });
  if (!bare.some((l) => l.startsWith('Portfolio:'))) pass('no empty Portfolio line when the profile has none');
  else fail('emitted a Portfolio line with no value');

  if (buildSignatureLines().length === 0) pass('an empty candidate map yields no signature lines');
  else fail('empty candidate produced stray lines');

  // The cover letter reads the same profile and used to forward only linkedin.
  const cover = readFileSync(join(ROOT, 'gemini-cover.mjs'), 'utf-8');
  if (/portfolio_url:/.test(cover) && /github:/.test(cover)) pass('cover-letter payload forwards github + portfolio');
  else fail('gemini-cover.mjs still drops github/portfolio from the contact line');

  const letter = readFileSync(join(ROOT, 'generate-cover-letter.mjs'), 'utf-8');
  if (/candidate\.portfolio_url/.test(letter)) pass('cover-letter contact line renders the portfolio');
  else fail('generate-cover-letter.mjs never renders a portfolio link');
} catch (err) {
  fail(`gemini-email signature test crashed: ${err.message}`);
}
