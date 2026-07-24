// tests/match-jobs.test.mjs — Phase 6 per-user matching + digest selection.
// No network: liveness and Telegram are never touched here.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';

console.log('\nPer-user job matching — match-jobs.mjs (Phase 6)');

const profile = {
  positives: ['qa', 'test automation', 'sdet', 'ai engineer'],
  negatives: ['intern', 'unpaid'],
  skills: ['selenium', 'playwright', 'python'],
  seniority: 'senior',
  blacklist: ['shadyrecruiters inc'],
};

try {
  const { scoreRow, rankPipeline, cvSkills, seniorityOf, titleTokens } =
    await import(pathToFileURL(join(ROOT, 'match-jobs.mjs')).href);

  // --- scoring --------------------------------------------------------------
  const strong = scoreRow({ title: 'Senior QA Engineer, Test Automation', company: 'Acme', location: 'Toronto, ON' }, profile);
  const weak = scoreRow({ title: 'Marketing Coordinator', company: 'Acme', location: 'Toronto, ON' }, profile);
  if (strong.score > weak.score) pass(`on-target title outranks an unrelated one (${strong.score} vs ${weak.score})`);
  else fail(`scoring inverted: ${strong.score} vs ${weak.score}`);

  if (strong.reasons.some((r) => /matches your targets/.test(r))) pass('score explains itself (target terms listed)');
  else fail(`no reasons attached: ${JSON.stringify(strong.reasons)}`);

  const remote = scoreRow({ title: 'QA Engineer', company: 'A', location: 'Remote, US' }, profile);
  const onsiteCa = scoreRow({ title: 'QA Engineer', company: 'A', location: 'Toronto, ON' }, profile);
  if (remote.score > onsiteCa.score) pass('remote outranks Canadian on-site, matching geo-policy order');
  else fail(`remote ${remote.score} should beat on-site ${onsiteCa.score}`);

  // --- hard drops -----------------------------------------------------------
  const intern = scoreRow({ title: 'QA Intern', company: 'A', location: 'Toronto, ON' }, profile);
  if (intern.drop) pass(`negative title term drops the row (${intern.drop})`);
  else fail('intern posting was not dropped');

  const blacklisted = scoreRow({ title: 'Senior QA Engineer', company: 'ShadyRecruiters Inc', location: 'Toronto, ON' }, profile);
  if (blacklisted.drop) pass('blacklisted company dropped');
  else fail('blacklist ignored');

  const foreign = scoreRow({ title: 'Senior QA Engineer', company: 'A', location: 'Berlin, Germany' }, profile);
  if (foreign.drop) pass('outside the geography policy dropped');
  else fail('foreign posting survived');

  const usOnsite = scoreRow({ title: 'Senior QA Engineer', company: 'A', location: 'Austin, TX' }, profile);
  if (usOnsite.drop) pass('US on-site dropped (policy is US-remote only)');
  else fail('US on-site survived');

  // --- the word-boundary bug found in the first live run --------------------
  // A substring test made the one-letter skill "r" match "QA Engineer ", so
  // every job claimed R as a matching skill.
  const rSkill = scoreRow({ title: 'QA Engineer', company: 'A', location: 'Toronto, ON' }, { ...profile, skills: ['r'] });
  if (!rSkill.reasons.some((x) => /skills in the title/.test(x))) pass('one-letter skill does not match inside another word');
  else fail(`"r" falsely matched: ${JSON.stringify(rSkill.reasons)}`);

  // --- seniority ------------------------------------------------------------
  const junior = scoreRow({ title: 'Junior QA Engineer', company: 'A', location: 'Toronto, ON' }, profile);
  const senior = scoreRow({ title: 'Senior QA Engineer', company: 'A', location: 'Toronto, ON' }, profile);
  if (senior.score > junior.score) pass('a senior CV ranks senior roles above junior ones');
  else fail(`seniority ignored: senior ${senior.score} vs junior ${junior.score}`);

  if (seniorityOf('Senior QA Engineer with 8 years') === 'senior') pass('seniorityOf reads the CV headline');
  else fail(`seniorityOf = ${seniorityOf('Senior QA Engineer with 8 years')}`);

  if (cvSkills('Built Selenium and Playwright suites in Python').includes('selenium')) pass('cvSkills extracts skills from a CV');
  else fail('cvSkills missed selenium');

  if (!titleTokens('The QA Role for You').includes('the')) pass('titleTokens drops stopwords');
  else fail('stopword survived tokenization');

  // --- ranking over a real pipeline file ------------------------------------
  const root = mkdtempSync(join(tmpdir(), 'match-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'cv.md'), 'Senior QA Engineer. Selenium, Playwright, Python, CI/CD.');
  writeFileSync(join(root, 'portals.yml'),
    'title_filter:\n  positive:\n    - qa\n    - sdet\n  negative:\n    - intern\n');
  writeFileSync(join(root, 'data', 'pipeline.md'), [
    '# Pipeline', '', '## Pending', '',
    '- [ ] https://x.test/1 | Acme | Senior QA Engineer | Remote, US',
    '- [ ] https://x.test/2 | Beta | QA Intern | Toronto, ON',
    '- [ ] https://x.test/3 | Gamma | Senior SDET | Toronto, ON',
    '- [ ] https://x.test/4 | Delta | Chef | Berlin, Germany',
  ].join('\n'));

  const ranked = rankPipeline(root);
  if (ranked.matches.length === 2 && ranked.dropped.length === 2) pass('rankPipeline keeps the 2 relevant rows, drops intern + foreign');
  else fail(`ranked ${ranked.matches.length} kept / ${ranked.dropped.length} dropped: ${JSON.stringify(ranked.matches.map((m) => m.title))}`);

  if (ranked.matches[0].url === 'https://x.test/1') pass('remote senior QA ranks first');
  else fail(`first match was ${ranked.matches[0]?.title}`);

  if (ranked.matches.every((m, i, a) => i === 0 || a[i - 1].score >= m.score)) pass('results are sorted by descending fit');
  else fail('ranking not sorted');

  // --- digest selection + isolation ----------------------------------------
  const digest = await import(pathToFileURL(join(ROOT, 'daily-digest.mjs')).href);
  const { selectNew, renderDigest, digestKeyboard, readState, writeState } = digest;

  const fresh = selectNew(ranked.matches, [], { top: 5, minScore: 0 });
  if (fresh.length === 2) pass('selectNew offers every unseen match');
  else fail(`selectNew returned ${fresh.length}`);

  const repeat = selectNew(ranked.matches, ['https://x.test/1'], { top: 5, minScore: 0 });
  if (repeat.length === 1 && repeat[0].url === 'https://x.test/3') pass('already-announced jobs are never repeated');
  else fail(`repeat suppression failed: ${JSON.stringify(repeat.map((r) => r.url))}`);

  const floored = selectNew(ranked.matches, [], { top: 5, minScore: 999 });
  if (floored.length === 0) pass('the relevance floor suppresses weak matches');
  else fail('min-score ignored');

  const capped = selectNew(ranked.matches, [], { top: 1, minScore: 0 });
  if (capped.length === 1) pass('--top caps the digest length');
  else fail(`top cap ignored (${capped.length})`);

  // Telegram rejects callback_data over 64 bytes — the message would fail to send.
  const kb = digestKeyboard(ranked.matches);
  const oversized = kb.inline_keyboard.flat().filter((b) => Buffer.byteLength(b.callback_data) > 64);
  if (oversized.length === 0) pass('every callback_data fits Telegram\'s 64-byte cap');
  else fail(`oversized callback_data: ${JSON.stringify(oversized)}`);

  const text = renderDigest(ranked.matches, { name: 'Alex Doe', totalMatched: 9 });
  if (text.includes('Alex') && text.includes('https://x.test/1') && /7 more/.test(text))
    pass('digest renders greeting, links, and the remaining count');
  else fail(`digest text wrong:\n${text}`);

  // Job titles carry *, _ and [ ] constantly; the digest must not be Markdown.
  if (!/[*_]{1}\w|\[.+\]\(/.test(text.replace(/https?:\/\/\S+/g, ''))) pass('digest body is plain text (no Markdown to break on)');
  else fail('digest emits Markdown that a job title could break');

  // --- per-user ledger isolation -------------------------------------------
  const rootB = mkdtempSync(join(tmpdir(), 'match-b-'));
  mkdirSync(join(rootB, 'data'), { recursive: true });
  writeState(root, { sent: ['https://x.test/1'], paused: false });
  writeState(rootB, { sent: ['https://other.test/9'], paused: true });
  const a = readState(root);
  const b = readState(rootB);
  if (!a.sent.includes('https://other.test/9') && !b.sent.includes('https://x.test/1'))
    pass('digest ledgers are per-user — no cross-user leakage');
  else fail('one user\'s digest state bled into another');

  if (a.paused === false && b.paused === true) pass('pause is per-user (/digest off affects only the caller)');
  else fail('pause flag leaked across users');

  const state = JSON.parse(readFileSync(join(root, 'data', 'digest-state.json'), 'utf-8'));
  if (Array.isArray(state.sent)) pass('ledger persists as JSON inside the user root');
  else fail('ledger not written correctly');

  writeState(root, { sent: Array.from({ length: 900 }, (_, i) => `u${i}`) });
  if (readState(root).sent.length === 500) pass('ledger is capped at 500 URLs (bounded on a daily cron)');
  else fail(`ledger grew to ${readState(root).sent.length}`);
} catch (err) {
  fail(`match-jobs test crashed: ${err.message}`);
}
