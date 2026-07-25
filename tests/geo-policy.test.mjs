// tests/geo-policy.test.mjs — Canadian-worker geography policy (no network).
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nGeo policy — geo-policy.mjs');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'geo-policy.mjs')).href);
  const { detectCountry, classifyRow, parsePipelineRow, postedAgeDays, DEFAULT_MAX_POSTING_AGE_DAYS } = mod;

  // --- detectCountry ------------------------------------------------------
  const ca = ['Toronto, ON', 'Vancouver, British Columbia', 'Montréal, QC', 'Canada', 'Ottawa'];
  const us = ['Austin, TX', 'New York, New York, USA', 'Denver, Colorado', 'Remote - United States', 'San Francisco, CA'];
  if (ca.every((l) => detectCountry(l) === 'CA')) pass('detectCountry finds Canada (names + codes)');
  else fail(`CA detect: ${ca.map((l) => l + '=' + detectCountry(l))}`);
  if (us.every((l) => detectCountry(l) === 'US')) pass('detectCountry finds US (names, codes, full state)');
  else fail(`US detect: ${us.map((l) => l + '=' + detectCountry(l))}`);
  if (detectCountry('London, UK') === null && detectCountry('Berlin, Germany') === null)
    pass('detectCountry returns null for foreign locations');
  else fail('foreign should be null');
  if (detectCountry('London, ON') === 'CA') pass('trailing code wins: "London, ON" is Canada, not UK');
  else fail(`London, ON = ${detectCountry('London, ON')}`);

  // --- classifyRow (the policy: all Canada + US remote only, remote ranked 0)
  const cases = [
    [{ title: 'QA', location: 'Toronto, ON' }, true, 1, 'Canada on-site kept, rank 1'],
    [{ title: 'QA', location: 'Vancouver, BC' }, true, 1, 'Canada hybrid/on-site kept'],
    [{ title: 'Remote QA', location: 'Austin, TX' }, true, 0, 'US remote kept, rank 0 (title remote)'],
    [{ title: 'QA', location: 'Remote, US' }, true, 0, 'US remote kept (location remote)'],
    [{ title: 'QA', location: 'Toronto, ON (Remote)' }, true, 0, 'Canada remote ranks above Canada on-site'],
    [{ title: 'QA', location: 'Anywhere in the World' }, true, 0, 'worldwide remote kept, rank 0'],
    [{ title: 'QA', location: 'USA Only' }, true, 0, 'remote-board "USA Only" kept as remote'],
    [{ title: 'QA', location: 'New York, NY' }, false, null, 'US on-site DROPPED (no sponsor rule anymore)'],
    [{ title: 'QA', location: 'San Francisco, CA' }, false, null, 'US on-site DROPPED'],
    [{ title: 'QA', location: 'London, UK' }, false, null, 'foreign dropped'],
    [{ title: 'QA', location: '' }, true, 2, 'unknown location kept, rank 2 (bottom)'],
  ];
  let ok = 0;
  for (const [row, expectKeep, expectRank, label] of cases) {
    const r = classifyRow(row);
    const rankOk = !expectKeep || r.rank === expectRank;
    if (r.keep === expectKeep && rankOk) { ok += 1; } else { fail(`${label} — got keep=${r.keep} rank=${r.rank} (${r.reason})`); }
  }
  if (ok === cases.length) pass(`classifyRow enforces policy + ranking (${ok}/${cases.length})`);

  // Remote is rank 0, Canada on-site rank 1, unknown rank 2 → remote sorts first.
  const ranks = [
    classifyRow({ title: 'QA', location: 'Toronto, ON' }).rank,
    classifyRow({ title: 'QA', location: 'Remote, Canada' }).rank,
    classifyRow({ title: 'QA', location: '' }).rank,
  ];
  if (ranks[1] < ranks[0] && ranks[0] < ranks[2]) pass('rank order: remote < Canada on-site < unknown');
  else fail(`ranks = ${JSON.stringify(ranks)}`);

  // --- hub-city rule (2026-07-24 owner policy) ----------------------------
  // Canada that is NOT remote must be commutable: Vancouver, Calgary, Toronto.
  const hubCases = [
    [{ title: 'QA', location: 'Calgary, AB' }, true, 'Calgary hybrid kept'],
    [{ title: 'QA', location: 'Greater Toronto Area' }, true, 'GTA phrasing kept'],
    [{ title: 'QA', location: 'North York, ON' }, true, 'Toronto metro suburb kept'],
    [{ title: 'QA', location: 'Ottawa, ON' }, false, 'Ottawa on-site dropped (not a hub city)'],
    [{ title: 'QA', location: 'Halifax, NS' }, false, 'Halifax on-site dropped'],
    [{ title: 'QA', location: 'Montréal, QC' }, false, 'Montreal on-site dropped'],
    [{ title: 'QA', location: 'Remote — Halifax, NS' }, true, 'remote anywhere in Canada still kept'],
    [{ title: 'QA', location: 'Remote (Canada)' }, true, 'Canada-wide remote kept'],
  ];
  let hubOk = 0;
  for (const [r, expectKeep, label] of hubCases) {
    const got = classifyRow(r);
    if (got.keep === expectKeep) hubOk += 1;
    else fail(`${label} — got keep=${got.keep} (${got.reason})`);
  }
  if (hubOk === hubCases.length) pass(`Canada non-remote limited to hub cities (${hubOk}/${hubCases.length})`);

  // India stays gated behind the toggle, at any modality.
  const inRow = { title: 'QA Lead', location: 'Bengaluru, India' };
  if (classifyRow(inRow).keep === false && classifyRow(inRow, { includeIndia: true }).keep === true)
    pass('India honours the toggle for on-site roles');
  else fail('India toggle regressed');

  // --- posting age --------------------------------------------------------
  const now = Date.parse('2026-07-24T12:00:00Z');
  if (postedAgeDays('2026-07-24', now) === 0 && postedAgeDays('2026-07-17', now) === 7
      && postedAgeDays(null, now) === null && postedAgeDays('garbage', now) === null)
    pass('postedAgeDays measures whole days and tolerates missing/garbage dates');
  else fail(`ages = ${postedAgeDays('2026-07-17', now)} / ${postedAgeDays('garbage', now)}`);
  if (DEFAULT_MAX_POSTING_AGE_DAYS === 7) pass('the default posting-age window is 7 days');
  else fail(`default age = ${DEFAULT_MAX_POSTING_AGE_DAYS}`);

  // --- parsePipelineRow ---------------------------------------------------
  const row = parsePipelineRow('- [ ] https://x/y | Stripe | Senior QA | New York, NY | posted: 2026-07-20');
  if (row && row.company === 'Stripe' && row.location === 'New York, NY' && row.title === 'Senior QA')
    pass('parsePipelineRow splits the pipeline columns');
  else fail(`parsePipelineRow = ${JSON.stringify(row)}`);
  if (row && row.posted === '2026-07-20') pass('parsePipelineRow reads the labeled posted: date');
  else fail(`posted = ${row && row.posted}`);
  // Compensation shifts the trailing cells, so the date must be found by label.
  const withComp = parsePipelineRow('- [ ] https://x/y | Acme | QA Lead | Toronto, ON | $120k | posted: 2026-07-22 | note: hot');
  if (withComp && withComp.posted === '2026-07-22' && withComp.location === 'Toronto, ON')
    pass('parsePipelineRow finds posted: past compensation and note columns');
  else fail(`withComp = ${JSON.stringify(withComp)}`);
  if (parsePipelineRow('- [ ] https://x/y | Acme | QA Lead | Toronto, ON').posted === null)
    pass('parsePipelineRow yields null posted when the row carries no date');
  else fail('undated row should have posted=null');
  if (parsePipelineRow('## Pending') === null && parsePipelineRow('') === null)
    pass('parsePipelineRow ignores headers/blank lines');
  else fail('parsePipelineRow should ignore non-rows');
} catch (err) {
  fail(`geo-policy test crashed: ${err.message}`);
}
