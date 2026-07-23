// tests/find-contact-email.test.mjs — name/domain/pattern logic (no network).
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nContact email — find-contact-email.mjs');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'find-contact-email.mjs')).href);
  const { parseName, deriveDomain, generatePatterns, parseAccount, writeHunterKey } = mod;

  // --- parseName ----------------------------------------------------------
  const jane = parseName('Jane Smith');
  if (jane && jane.first === 'jane' && jane.last === 'smith') pass('parseName splits first/last');
  else fail(`parseName = ${JSON.stringify(jane)}`);
  const accented = parseName('José García-López');
  if (accented && accented.first === 'jose' && accented.last === 'garcialopez')
    pass('parseName strips accents/punctuation (uses last token)');
  else fail(`parseName accented = ${JSON.stringify(accented)}`);
  if (parseName('Cher') && parseName('Cher').last === '') pass('parseName handles single names');
  else fail('single name should have empty last');
  if (parseName('   ') === null) pass('parseName returns null for blank');
  else fail('blank name should be null');

  // --- deriveDomain -------------------------------------------------------
  if (deriveDomain('acme.com') === 'acme.com') pass('deriveDomain passes a real domain through');
  else fail(`deriveDomain(acme.com) = ${deriveDomain('acme.com')}`);
  if (deriveDomain('https://www.acme.com/careers') === 'www.acme.com')
    pass('deriveDomain strips scheme/path from a URL');
  else fail(`deriveDomain(url) = ${deriveDomain('https://www.acme.com/careers')}`);
  if (deriveDomain('NetBrain') === 'netbrain.com') pass('deriveDomain guesses domain from a company name');
  else fail(`deriveDomain(NetBrain) = ${deriveDomain('NetBrain')}`);
  if (deriveDomain('The Dignify Solutions LLC') === 'dignify.com')
    pass('deriveDomain strips legal suffixes + filler words');
  else fail(`deriveDomain(Dignify) = ${deriveDomain('The Dignify Solutions LLC')}`);

  // --- generatePatterns ---------------------------------------------------
  const pats = generatePatterns('jane', 'smith', 'acme.com');
  if (pats[0] === 'jane.smith@acme.com') pass('generatePatterns ranks first.last first');
  else fail(`patterns[0] = ${pats[0]}`);
  if (pats.includes('jsmith@acme.com') && pats.includes('jane@acme.com'))
    pass('generatePatterns includes flast and first-only forms');
  else fail(`patterns = ${JSON.stringify(pats)}`);
  if (new Set(pats).size === pats.length) pass('generatePatterns are unique');
  else fail('patterns contain duplicates');
  if (generatePatterns('cher', '', 'acme.com').join() === 'cher@acme.com')
    pass('generatePatterns handles single-name (first-only)');
  else fail(`single-name patterns = ${JSON.stringify(generatePatterns('cher', '', 'acme.com'))}`);
  if (generatePatterns('jane', 'smith', '').length === 0)
    pass('generatePatterns returns [] without a domain');
  else fail('no-domain should yield no patterns');

  // --- parseAccount (Hunter usage) ---------------------------------------
  const acct = parseAccount({ data: { requests: { searches: { used: 7, available: 43 } }, reset_date: '2026-08-23' } });
  if (acct && acct.used === 7 && acct.available === 43 && acct.limit === 50 && acct.resetDate === '2026-08-23')
    pass('parseAccount reads used/available and derives the 50 limit');
  else fail(`parseAccount = ${JSON.stringify(acct)}`);
  if (parseAccount({ data: { calls: { used: 2, available: 48 } } })?.limit === 50)
    pass('parseAccount falls back to the legacy calls shape');
  else fail('parseAccount legacy shape failed');
  if (parseAccount({ errors: [{ id: 'unauthorized' }] }) === null)
    pass('parseAccount returns null for an error/invalid-key response');
  else fail('parseAccount should be null on error');

  // --- writeHunterKey (comment-preserving profile edit) ------------------
  const { mkdtempSync, rmSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const tmp = mkdtempSync(join((await import('node:os')).tmpdir(), 'hunter-'));
  try {
    const p = join(tmp, 'profile.yml');
    writeFileSync(p, 'candidate:\n  full_name: "Rahul"\n# a comment\n');
    writeHunterKey(p, 'ABC123KEY456DEF789GH');
    const out1 = readFileSync(p, 'utf-8');
    if (out1.includes('integrations:') && out1.includes('hunter_api_key: "ABC123KEY456DEF789GH"') && out1.includes('# a comment'))
      pass('writeHunterKey appends an integrations block, preserving comments');
    else fail(`writeHunterKey add:\n${out1}`);
    writeHunterKey(p, 'NEWKEY000111222333');
    const out2 = readFileSync(p, 'utf-8');
    if (out2.includes('hunter_api_key: "NEWKEY000111222333"') && !out2.includes('ABC123KEY'))
      pass('writeHunterKey replaces an existing key');
    else fail(`writeHunterKey replace:\n${out2}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
} catch (err) {
  fail(`find-contact-email test crashed: ${err.message}`);
}
