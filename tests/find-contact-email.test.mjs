// tests/find-contact-email.test.mjs — name/domain/pattern logic (no network).
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nContact email — find-contact-email.mjs');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'find-contact-email.mjs')).href);
  const { parseName, deriveDomain, generatePatterns } = mod;

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
} catch (err) {
  fail(`find-contact-email test crashed: ${err.message}`);
}
