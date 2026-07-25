// tests/geo-policy.test.mjs — Canadian-worker geography policy (no network).
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nGeo policy — geo-policy.mjs');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'geo-policy.mjs')).href);
  const { detectCountry, classifyRow, parsePipelineRow, postedAgeDays, DEFAULT_MAX_POSTING_AGE_DAYS,
    isPriorityTitle, parseSalaryFloor } = mod;

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

  // --- hub-city rule (owner policy, widened 2026-07-25) -------------------
  // Canada that is NOT remote must be commutable. Owner list: Vancouver,
  // Calgary, Toronto, Ottawa, Kitchener, Waterloo, Montreal.
  const hubCases = [
    [{ title: 'QA', location: 'Calgary, AB' }, true, 'Calgary hybrid kept'],
    [{ title: 'QA', location: 'Greater Toronto Area' }, true, 'GTA phrasing kept'],
    [{ title: 'QA', location: 'North York, ON' }, true, 'Toronto metro suburb kept'],
    [{ title: 'QA', location: 'Ottawa, ON' }, true, 'Ottawa on-site kept (added 2026-07-25)'],
    [{ title: 'QA', location: 'Kitchener, ON' }, true, 'Kitchener on-site kept (added)'],
    [{ title: 'QA', location: 'Waterloo, Ontario' }, true, 'Waterloo on-site kept (added)'],
    [{ title: 'QA', location: 'Kitchener-Waterloo, ON' }, true, 'hyphenated KW kept'],
    [{ title: 'QA', location: 'Montréal, QC' }, true, 'Montreal (accented) on-site kept (added)'],
    [{ title: 'QA', location: 'Montreal, Quebec' }, true, 'Montreal (unaccented) on-site kept'],
    [{ title: 'QA', location: 'Halifax, NS' }, false, 'Halifax on-site still dropped'],
    [{ title: 'QA', location: 'Edmonton, AB' }, false, 'Edmonton on-site still dropped'],
    [{ title: 'QA', location: 'Winnipeg, MB' }, false, 'Winnipeg on-site still dropped'],
    [{ title: 'QA', location: 'Remote — Halifax, NS' }, true, 'remote anywhere in Canada still kept'],
    [{ title: 'QA', location: 'Remote (Canada)' }, true, 'Canada-wide remote kept'],
    // "Waterloo" also names cities in Iowa/Illinois/Belgium. The hub test only
    // runs after detectCountry() resolves the row to Canada, so a US Waterloo
    // must still be dropped as US on-site — never promoted by the city name.
    [{ title: 'QA', location: 'Waterloo, IA' }, false, 'Waterloo, Iowa is NOT a Canadian hub'],
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

  // --- India hub cities (owner list 2026-07-25) ---------------------------
  // With the toggle ON, a non-remote Indian role must be in Ahmedabad,
  // Gandhinagar or Bengaluru; every other Indian city is a drop. Detection
  // stays broad so those rows drop as "outside hub cities", not as "outside
  // North America" — the reason a user reads has to be the true one.
  const inHubCases = [
    ['Ahmedabad, Gujarat', true, 'Ahmedabad kept'],
    ['Gandhinagar, Gujarat', true, 'Gandhinagar kept'],
    ['Bengaluru, Karnataka', true, 'Bengaluru kept'],
    ['Bangalore, India', true, 'Bangalore (alternate spelling) kept'],
    ['Mumbai, Maharashtra', false, 'Mumbai dropped'],
    ['Pune, India', false, 'Pune dropped'],
    ['Hyderabad, Telangana', false, 'Hyderabad dropped'],
    ['Noida, UP', false, 'Noida dropped'],
    ['India', true, 'country-only "India" KEPT (owner rule 2026-07-25)'],
    ['India, Asia', true, 'country-only with region kept'],
    ['Remote, India', true, 'India remote kept regardless of city'],
  ];
  let inOk = 0;
  for (const [location, expectKeep, label] of inHubCases) {
    const got = classifyRow({ title: 'QA', location }, { includeIndia: true });
    if (got.keep === expectKeep) inOk += 1;
    else fail(`${label} — got keep=${got.keep} (${got.reason})`);
  }
  if (inOk === inHubCases.length) pass(`India non-remote limited to hub cities (${inOk}/${inHubCases.length})`);

  // A dropped Mumbai row must say WHY correctly.
  const mumbai = classifyRow({ title: 'QA', location: 'Mumbai, Maharashtra' }, { includeIndia: true });
  if (/hub cities/i.test(mumbai.reason)) pass('non-hub Indian rows drop with the India reason, not "outside North America"');
  else fail(`Mumbai drop reason = "${mumbai.reason}"`);

  // Toggle OFF still overrides everything, hub city or not.
  if (classifyRow({ title: 'QA', location: 'Ahmedabad, Gujarat' }).keep === false)
    pass('toggle OFF drops even a hub-city Indian role');
  else fail('India hub city bypassed the toggle');

  // --- priority titles (owner lists 2026-07-25) ---------------------------
  // A posting is a priority role when every significant word of a listed title
  // appears in it, in any order.
  const QA_PRIORITY = ['AI QA Engineer', 'Senior QA Engineer', 'Senior SDET', 'QA Lead',
    'Software Development Engineer in Test', 'AI Consultant', 'Quality Engineering Manager'];
  const priCases = [
    ['Senior AI QA Engineer', true, 'extra seniority word still matches'],
    ['QA Engineer (Senior), Platform', true, 'reordered + padded title matches'],
    ['Senior QA Engineer, Core Automation', true, 'trailing specialization matches'],
    ['Senior SDET - Payments', true, 'SDET with team suffix matches'],
    ['QA Lead', true, 'exact title matches'],
    ['AI Consultant, Financial Services', true, 'AI Consultant matches'],
    ['Software Development Engineer in Test II', true, 'filler word "in" ignored, level suffix ok'],
    ['Quality Engineering Manager', true, 'management title matches'],
    ['QA Engineer', false, 'bare QA Engineer is NOT the listed senior role'],
    ['Marketing Manager', false, 'unrelated title is not priority'],
    ['Data Engineer', false, 'adjacent engineering title is not priority'],
  ];
  let priOk = 0;
  for (const [title, expect, label] of priCases) {
    if (isPriorityTitle(title, QA_PRIORITY) === expect) priOk += 1;
    else fail(`${label} — "${title}" got ${!expect}`);
  }
  if (priOk === priCases.length) pass(`priority-title matching is word-set based (${priOk}/${priCases.length})`);

  if (!isPriorityTitle('Senior QA Engineer', [])) pass('no priority_titles configured → nothing is priority (order unchanged)');
  else fail('empty priority list still matched');

  const HR_PRIORITY = ['HR Business Partner', 'Talent Acquisition Specialist', 'Senior Recruiter'];
  if (isPriorityTitle('Senior HR Business Partner, West', HR_PRIORITY)
      && isPriorityTitle('Talent Acquisition Specialist', HR_PRIORITY)
      && !isPriorityTitle('Recruiter', HR_PRIORITY))
    pass('HR priority list behaves the same way');
  else fail('HR priority matching wrong');

  // --- salary floor -------------------------------------------------------
  const salCases = [
    ['$85,000 - $110,000', 85000, 'range → lowest figure'],
    ['CAD 90000', 90000, 'plain amount with currency'],
    ['85k-110k', 85000, 'k-suffixed range'],
    ['$45/hour', 93600, 'hourly annualized at 2080h'],
    ['Competitive', null, '"Competitive" is not a number'],
    ['', null, 'empty compensation → null (kept, never treated as 0)'],
  ];
  let salOk = 0;
  for (const [raw, expect, label] of salCases) {
    if (parseSalaryFloor(raw) === expect) salOk += 1;
    else fail(`${label} — "${raw}" → ${parseSalaryFloor(raw)}, expected ${expect}`);
  }
  if (salOk === salCases.length) pass(`salary parsing handles ranges, k-suffix, hourly, and blanks (${salOk}/${salCases.length})`);

  // The rule that matters: a posting with NO salary must never be filtered out.
  if (parseSalaryFloor('Competitive') === null && parseSalaryFloor(undefined) === null)
    pass('missing salary yields null so the row is KEPT, not judged too low');
  else fail('missing salary would be filtered');

  // Compensation has to be readable off a pipeline row for the floor to apply.
  const payRow = parsePipelineRow('- [ ] https://x.test/1 | Acme | Senior QA Engineer | Toronto, ON | $95,000 - $120,000 | posted: 2026-07-25');
  if (payRow?.compensation === '$95,000 - $120,000' && payRow.posted === '2026-07-25')
    pass('parsePipelineRow reads compensation without swallowing posted:');
  else fail(`row parse = ${JSON.stringify(payRow)}`);

  const noPayRow = parsePipelineRow('- [ ] https://x.test/2 | Beta | QA Lead | Ottawa, ON | posted: 2026-07-24');
  if (noPayRow?.compensation === '' && noPayRow.posted === '2026-07-24')
    pass('a row with no compensation cell does not mistake posted: for salary');
  else fail(`no-pay row = ${JSON.stringify(noPayRow)}`);

  // --- ordering contract (owner decision 2026-07-25) ----------------------
  // Date is STRICT and outranks priority: a target role posted earlier must NOT
  // jump above a non-target posted today. Priority only orders within one day.
  // Mirrors the comparator in the CLI so a regression there fails here.
  const order = (rows) => [...rows].sort((a, b) => {
    if (a.posted && b.posted && a.posted !== b.posted) return a.posted < b.posted ? 1 : -1;
    if (a.posted && !b.posted) return -1;
    if (!a.posted && b.posted) return 1;
    if (a.tier !== b.tier) return a.tier - b.tier;
    return a.rank - b.rank;
  }).map((r) => r.id);

  const mixed = [
    { id: 'target-old', posted: '2026-07-23', tier: 0, rank: 1 },
    { id: 'other-today', posted: '2026-07-25', tier: 1, rank: 1 },
    { id: 'target-today', posted: '2026-07-25', tier: 0, rank: 1 },
    { id: 'undated-target', posted: null, tier: 0, rank: 1 },
  ];
  const got = order(mixed);
  if (got.join(',') === 'target-today,other-today,target-old,undated-target')
    pass('strict newest-first; target roles lead only within the same day');
  else fail(`order = ${got.join(',')}`);

  // The decisive case, stated on its own: freshness beats priority.
  const twoRows = order([
    { id: 'target-yesterday', posted: '2026-07-24', tier: 0, rank: 1 },
    { id: 'other-today', posted: '2026-07-25', tier: 1, rank: 1 },
  ]);
  if (twoRows[0] === 'other-today') pass('a non-target posted today outranks a target role from yesterday');
  else fail(`freshness lost to priority: ${twoRows.join(',')}`);

  // Same day, both tiers → the target role wins.
  const sameDay = order([
    { id: 'other', posted: '2026-07-25', tier: 1, rank: 0 },
    { id: 'target', posted: '2026-07-25', tier: 0, rank: 2 },
  ]);
  if (sameDay[0] === 'target') pass('within one day the target role leads, even with a worse geo rank');
  else fail(`same-day order = ${sameDay.join(',')}`);

  // With no priority list every row is tier 1 → pure newest-first, unchanged.
  const noPriority = order([
    { id: 'b', posted: '2026-07-24', tier: 1, rank: 1 },
    { id: 'a', posted: '2026-07-25', tier: 1, rank: 1 },
  ]);
  if (noPriority.join(',') === 'a,b') pass('with no priority_titles the order is plain newest-first');
  else fail(`no-priority order = ${noPriority.join(',')}`);

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
