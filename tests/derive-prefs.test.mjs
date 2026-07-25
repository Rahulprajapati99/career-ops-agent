// tests/derive-prefs.test.mjs — build a scan profile from a person's own résumé.
//
// The point of this module: a new family member can come from ANY field, so the
// onboarding scan must be derived from their CV rather than offering an existing
// member's role list. These tests use résumés from unrelated professions to keep
// the extraction honestly general rather than tuned to one QA resume.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nRésumé-derived scan profile — derive-prefs.mjs');

const QA_CV = `# Rahul P
Lead QA engineer, 9 years.

## Experience

### Senior QA Automation Analyst — BDO Canada (2021 - Present)
- Built Selenium and Playwright suites; cut regression time by 50%.

### QA Automation Analyst, Infosys (2018 - 2021)
- Wrote automated API tests.

## Skills
Selenium, Playwright, Python, SQL, CI/CD, Azure
`;

const NURSE_CV = `# Priya S
Registered Nurse with 8 years in acute care.

## Experience

### Senior Registered Nurse — Toronto General (2020 - Present)
- Led a team of 6 in the cardiac step-down unit.

### Registered Nurse, Mount Sinai (2017 - 2020)
- Administered medications and monitored vitals.

### Clinical Nurse Educator — Humber River (2016 - 2017)
- Trained new hires on charting.
`;

const WAREHOUSE_CV = `# Dan K
Warehouse operations.

## Work History

### Warehouse Supervisor — Loblaw DC (2019 - Present)
- Ran a 12-person shift.

### Forklift Operator, Sobeys (2015 - 2019)
- Moved palletized freight.
`;

const THIN_CV = `# Someone
I am a hard worker looking for opportunities. I am reliable and punctual.
References available on request.
`;

try {
  const { derivePrefsFromCv, extractTitles, deriveFilter, extractSkills, extractSeniority } =
    await import(pathToFileURL(join(ROOT, 'derive-prefs.mjs')).href);

  // --- titles come from the résumé, not a fixed vocabulary -----------------
  const qaTitles = extractTitles(QA_CV);
  if (qaTitles.some((t) => /QA Automation Analyst/i.test(t))) pass(`QA résumé yields its real title (${qaTitles[0]})`);
  else fail(`QA titles = ${JSON.stringify(qaTitles)}`);

  // Acronyms must not be mangled into "Qa".
  if (qaTitles.every((t) => !/\bQa\b/.test(t))) pass('acronyms stay upper-case ("QA", not "Qa")');
  else fail(`bad casing in ${JSON.stringify(qaTitles)}`);

  const nurseTitles = extractTitles(NURSE_CV);
  if (nurseTitles.some((t) => /Registered Nurse/i.test(t))) pass(`unrelated field works — nurse résumé yields ${JSON.stringify(nurseTitles.slice(0, 2))}`);
  else fail(`nurse titles = ${JSON.stringify(nurseTitles)}`);

  const whTitles = extractTitles(WAREHOUSE_CV);
  if (whTitles.some((t) => /Warehouse Supervisor|Forklift Operator/i.test(t))) pass('trades résumé yields its titles too');
  else fail(`warehouse titles = ${JSON.stringify(whTitles)}`);

  // Prose bullets must never be mistaken for job titles.
  if (!qaTitles.some((t) => /cut regression|built selenium/i.test(t))) pass('achievement bullets are not treated as titles');
  else fail(`prose leaked into titles: ${JSON.stringify(qaTitles)}`);

  // --- filter is broader than the titles ----------------------------------
  const filter = deriveFilter(['Senior QA Automation Analyst']);
  if (filter.some((f) => /automation analyst/.test(f)) && filter.every((f) => !/senior/.test(f)))
    pass('filter drops seniority so junior-of-the-same-role postings still arrive');
  else fail(`filter = ${JSON.stringify(filter)}`);

  const nurseFilter = deriveFilter(nurseTitles);
  if (nurseFilter.some((f) => /registered nurse|clinical nurse/.test(f))) pass('nurse filter targets nursing roles');
  else fail(`nurse filter = ${JSON.stringify(nurseFilter)}`);

  // --- skills + seniority --------------------------------------------------
  const skills = extractSkills(QA_CV);
  if (skills.includes('selenium') && skills.includes('playwright')) pass('skills come from the shared ATS vocabulary');
  else fail(`skills = ${JSON.stringify(skills)}`);

  // Returns the HIGHEST-ranked seniority present, not the first one encountered:
  // the QA résumé says both "Lead QA engineer" (headline) and "Senior QA
  // Automation Analyst" (title), and senior outranks lead in the scale.
  if (extractSeniority(QA_CV) === 'senior' && extractSeniority(NURSE_CV) === 'senior')
    pass('seniority read from the résumé, highest rank wins when several appear');
  else fail(`seniority = ${extractSeniority(QA_CV)} / ${extractSeniority(NURSE_CV)}`);

  if (extractSeniority('Lead Warehouse Supervisor with 10 years') === 'lead'
      && extractSeniority('Warehouse Supervisor') === '')
    pass('a lone seniority word is read, and its absence yields no claim');
  else fail(`lead-only = "${extractSeniority('Lead Warehouse Supervisor')}", none = "${extractSeniority('Warehouse Supervisor')}"`);

  // --- the whole profile ---------------------------------------------------
  for (const [label, cv] of [['QA', QA_CV], ['nurse', NURSE_CV], ['warehouse', WAREHOUSE_CV]]) {
    const p = derivePrefsFromCv(cv);
    const ok = p.confident && p.titles.length >= 2 && p.filter.length >= 1
      && typeof p.search_any === 'string' && p.search_any.length > 0
      && typeof p.google_query === 'string' && p.google_query.includes('"')
      && Array.isArray(p.yc_roles);
    if (ok) pass(`${label} résumé produces a complete, preset-shaped profile`);
    else fail(`${label} profile incomplete: ${JSON.stringify(p)}`);
  }

  // A résumé with no job history must NOT silently configure a junk search.
  const thin = derivePrefsFromCv(THIN_CV);
  if (thin.confident === false) pass('a résumé with no titles reports confident=false instead of guessing');
  else fail(`thin résumé claimed confidence: ${JSON.stringify(thin.titles)}`);

  if (derivePrefsFromCv('').confident === false) pass('empty résumé is handled without throwing');
  else fail('empty résumé claimed confidence');

  // Determinism: the same CV must always give the same search, or a user's
  // pipeline would churn between scans for no reason.
  const a = JSON.stringify(derivePrefsFromCv(QA_CV));
  const b = JSON.stringify(derivePrefsFromCv(QA_CV));
  if (a === b) pass('derivation is deterministic (same CV → same search)');
  else fail('derivation is not stable across calls');

  // Two different people must not end up with the same search.
  const qaProfile = derivePrefsFromCv(QA_CV);
  const nurseProfile = derivePrefsFromCv(NURSE_CV);
  const overlap = qaProfile.filter.filter((f) => nurseProfile.filter.includes(f));
  if (overlap.length === 0) pass('unrelated résumés yield disjoint searches (no cross-contamination)');
  else fail(`filters overlapped: ${JSON.stringify(overlap)}`);

  // --- the derived titles must actually work as priority titles -----------
  const { isPriorityTitle } = await import(pathToFileURL(join(ROOT, 'geo-policy.mjs')).href);
  if (isPriorityTitle('Senior QA Automation Analyst, Platform', qaProfile.titles))
    pass('derived titles feed geo-policy priority ranking');
  else fail(`derived titles did not match a real posting: ${JSON.stringify(qaProfile.titles)}`);

  if (!isPriorityTitle('Registered Nurse', qaProfile.titles))
    pass('a derived QA profile does not prioritize unrelated postings');
  else fail('QA profile matched a nursing title');
} catch (err) {
  fail(`derive-prefs test crashed: ${err.message}`);
}
