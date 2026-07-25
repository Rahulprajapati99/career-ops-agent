// tests/job-prefs.test.mjs — role presets + comment-preserving portals.yml edits.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import yaml from 'js-yaml';

console.log('\nJob preferences — job-prefs.mjs');

const SAMPLE = `# portals.yml — CUSTOMIZE me
# Second banner line.

scan_history:
  recheck_after_days: 30

# ── Title filter ──
title_filter:
  positive:
    - engineer
    - developer
  negative:
    - unpaid
    - volunteer

location_filter:
  block:
    - "India"

job_boards:
  - name: Adzuna Canada
    provider: adzuna
    country: ca
    what: "software engineer"        # CUSTOMIZE
    max_days_old: 7

  - name: Google Jobs (Canada)
    provider: serpapi
    q: "software engineer"
    location: "Canada"

  - name: Y Combinator
    provider: ycombinator
    roles: [eng, product, operations]   # CUSTOMIZE
`;

try {
  const mod = await import(pathToFileURL(join(ROOT, 'job-prefs.mjs')).href);
  const {
    loadPresets, resolveUserId, applyPreset, summarize,
    setTopLevelScalar, replaceListUnder, readListUnder, editTopLevelBlock, setSearchQueries,
  } = mod;

  // --- presets file -------------------------------------------------------
  const { presets, globalNegative } = loadPresets();
  if (presets['qa-ai'] && presets['hr-talent']) pass('role-presets.yml ships the qa-ai and hr-talent presets');
  else fail(`presets = ${Object.keys(presets).join(',')}`);

  if (presets['qa-ai'].filter.includes('quality assurance') && presets['qa-ai'].filter.includes('qa'))
    pass('qa-ai filters on short root phrases, not full seniority titles');
  else fail(`qa-ai filter = ${JSON.stringify(presets['qa-ai'].filter)}`);

  if (presets['hr-talent'].filter.includes('talent acquisition') && presets['hr-talent'].titles.length >= 30)
    pass('hr-talent carries the full title list and its root filters');
  else fail(`hr-talent = ${JSON.stringify(presets['hr-talent'].filter)}`);

  if (globalNegative.includes('intern') && globalNegative.includes('volunteer'))
    pass('global_negative excludes interns and volunteer roles');
  else fail(`global_negative = ${JSON.stringify(globalNegative)}`);

  // --- user resolution ----------------------------------------------------
  const ids = ['8772217091', '1234568910', '_global'];
  if (resolveUserId('7091', ids) === '8772217091' && resolveUserId('8910', ids) === '1234568910')
    pass('resolveUserId accepts a unique id suffix');
  else fail('suffix resolution failed');
  if (resolveUserId('8772217091', ids) === '8772217091') pass('resolveUserId accepts the full id');
  else fail('full id resolution failed');
  try {
    resolveUserId('1', ['11', '21']);
    fail('ambiguous suffix should throw');
  } catch { pass('resolveUserId refuses an ambiguous suffix instead of guessing'); }
  try {
    resolveUserId('999', ids);
    fail('unknown suffix should throw');
  } catch { pass('resolveUserId throws on an unknown user'); }

  // --- applying a preset --------------------------------------------------
  const { text: applied } = applyPreset(SAMPLE, presets['qa-ai'], globalNegative);
  const parsed = yaml.load(applied);

  if (parsed.title_filter.positive.includes('quality assurance')
      && !parsed.title_filter.positive.includes('engineer'))
    pass('applyPreset replaces title_filter.positive with the preset roles');
  else fail(`positive = ${JSON.stringify(parsed.title_filter.positive)}`);

  if (parsed.title_filter.negative.includes('intern') && parsed.title_filter.negative.includes('unpaid'))
    pass('applyPreset merges global_negative with the user existing exclusions');
  else fail(`negative = ${JSON.stringify(parsed.title_filter.negative)}`);

  // Regression: the merge once scraped every `- item` in the title_filter block,
  // so a user's own exclusions were discarded and their ROLES were read as
  // exclusions. User-specific negatives must survive a preset switch.
  const CUSTOM = SAMPLE.replace('    - volunteer\n', '    - volunteer\n    - junior\n    - co-op\n');
  const customApplied = yaml.load(applyPreset(CUSTOM, presets['qa-ai'], globalNegative).text);
  if (customApplied.title_filter.negative.includes('junior')
      && customApplied.title_filter.negative.includes('co-op')
      && customApplied.title_filter.negative.includes('intern'))
    pass('user-specific negatives survive a preset apply');
  else fail(`custom negatives = ${JSON.stringify(customApplied.title_filter.negative)}`);
  if (!customApplied.title_filter.negative.some((n) => presets['qa-ai'].filter.includes(n)))
    pass('preset roles never leak into the negative list');
  else fail(`roles leaked into negatives = ${JSON.stringify(customApplied.title_filter.negative)}`);

  if (readListUnder('  negative:\n    - "a"\n    - b\n  other:\n', 'negative').join(',') === 'a,b')
    pass('readListUnder reads only its own sub-list, unquoting values');
  else fail(`readListUnder = ${JSON.stringify(readListUnder('  negative:\n    - "a"\n    - b\n  other:\n', 'negative'))}`);

  if (parsed.max_posting_age_days === 7) pass('applyPreset enforces the 7-day posting-age rule');
  else fail(`max_posting_age_days = ${parsed.max_posting_age_days}`);

  const adzuna = parsed.job_boards.find((b) => b.provider === 'adzuna');
  if (adzuna.what_or === presets['qa-ai'].search_any && adzuna.what === undefined)
    pass('applyPreset converts Adzuna what → what_or (ANY keyword, one request)');
  else fail(`adzuna = ${JSON.stringify(adzuna)}`);

  const serp = parsed.job_boards.find((b) => b.provider === 'serpapi');
  if (serp.q === presets['qa-ai'].google_query) pass('applyPreset rewrites the SerpApi query');
  else fail(`serpapi q = ${JSON.stringify(serp.q)}`);

  // Assert against the preset's OWN list rather than a hardcoded literal: the
  // role categories track the preset's target titles (adding "AI Product
  // Analyst" legitimately added `product`), so a duplicated literal here would
  // fail on every such edit while testing nothing extra.
  const yc = parsed.job_boards.find((b) => b.provider === 'ycombinator');
  const wantRoles = presets['qa-ai'].yc_roles.join(',');
  if (Array.isArray(yc.roles) && yc.roles.join(',') === wantRoles)
    pass(`applyPreset narrows the Y Combinator role categories (${wantRoles})`);
  else fail(`yc roles = ${JSON.stringify(yc.roles)}, expected ${wantRoles}`);

  // --- comments survive ---------------------------------------------------
  if (applied.includes('# portals.yml — CUSTOMIZE me')
      && applied.includes('# ── Title filter ──')
      && applied.includes('# CUSTOMIZE'))
    pass('applyPreset preserves the comments that document portals.yml');
  else fail('comments were destroyed by the edit');

  // --- idempotence --------------------------------------------------------
  const twice = applyPreset(applied, presets['qa-ai'], globalNegative).text;
  if (twice === applied) pass('applyPreset is idempotent (re-running changes nothing)');
  else fail('second apply produced a different document');

  // --- switching presets --------------------------------------------------
  const hr = yaml.load(applyPreset(applied, presets['hr-talent'], globalNegative).text);
  if (hr.title_filter.positive.includes('talent acquisition')
      && !hr.title_filter.positive.includes('quality assurance'))
    pass('switching presets fully replaces the previous roles');
  else fail(`switched positive = ${JSON.stringify(hr.title_filter.positive)}`);

  // --- helper edge cases --------------------------------------------------
  if (setTopLevelScalar('a: 1\n', 'max_posting_age_days', '7').includes('max_posting_age_days: 7'))
    pass('setTopLevelScalar inserts a missing key');
  else fail('scalar insert failed');
  if (setTopLevelScalar('max_posting_age_days: 30\n', 'max_posting_age_days', '7')
    === 'max_posting_age_days: 7\n')
    pass('setTopLevelScalar replaces an existing key in place');
  else fail('scalar replace failed');

  if (editTopLevelBlock(SAMPLE, 'nope', () => 'x') === null)
    pass('editTopLevelBlock returns null for an absent key');
  else fail('missing key should yield null');

  if (replaceListUnder('  positive:\n    - a\n  negative:\n', 'positive', ['b'])
    === '  positive:\n    - "b"\n  negative:\n')
    pass('replaceListUnder swaps only its own list');
  else fail('list replace bled into the next key');

  if (setSearchQueries('  what: "x"\n', { searchAny: 'a b' }) === '  what_or: "a b"\n'
      && setSearchQueries('  what_or: "old"\n', { searchAny: 'a b' }) === '  what_or: "a b"\n')
    pass('setSearchQueries handles both the first conversion and later updates');
  else fail('search query rewrite failed');

  // --- summarize ----------------------------------------------------------
  const s = summarize(applied);
  if (s.maxPostingAgeDays === 7 && s.queries.includes(presets['qa-ai'].search_any) && s.includeIndia === false)
    pass('summarize reports the effective search config');
  else fail(`summary = ${JSON.stringify(s)}`);
} catch (err) {
  fail(`job-prefs test crashed: ${err.message}`);
}
