// tests/india-toggle.test.mjs — Phase 8 India geography toggle (no network).
//
// India ships DISABLED. These tests pin both halves of that promise: nothing
// Indian leaks in while the toggle is off, and flipping it on takes exactly one
// command across all three places that had to agree.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';

console.log('\nIndia toggle — india-toggle.mjs + geo-policy (Phase 8)');

const PORTALS_FIXTURE = `# search config
scan_history:
  recheck_after_days: 30

title_filter:
  positive:
    - qa

location_filter:
  block:
    - "India"
    - "Bengaluru"
    - "Germany"

job_boards:
  - name: Adzuna Canada
    provider: adzuna
    country: ca
    enabled: true

  - name: Adzuna India
    provider: adzuna
    country: in
    enabled: false
    notes: "DEFERRED toggle"
`;

try {
  const { readIndiaState, setIndia } = await import(pathToFileURL(join(ROOT, 'india-toggle.mjs')).href);
  const { classifyRow, detectCountry, indiaEnabled } = await import(pathToFileURL(join(ROOT, 'geo-policy.mjs')).href);

  // --- geo-policy: India is invisible until opted in ------------------------
  if (detectCountry('Bengaluru, Karnataka') === 'IN' && detectCountry('Pune, India') === 'IN')
    pass('detectCountry recognizes Indian cities');
  else fail(`detectCountry: ${detectCountry('Bengaluru, Karnataka')}`);

  // "IN" is also Indiana's postal code — the city/country names must win.
  if (detectCountry('Indianapolis, IN') === 'US') pass('"Indianapolis, IN" is still the US, not India');
  else fail(`Indiana misread as India: ${detectCountry('Indianapolis, IN')}`);

  const offSite = classifyRow({ title: 'QA Engineer', location: 'Bengaluru, India' });
  if (!offSite.keep) pass('India on-site dropped while the toggle is off');
  else fail('Indian posting leaked with the toggle off');

  // The remote fast-path must not become a back door.
  const offRemote = classifyRow({ title: 'Remote QA Engineer', location: 'Bengaluru, India' });
  if (!offRemote.keep) pass('India REMOTE also dropped while off (remote is not a bypass)');
  else fail('India-remote bypassed the toggle');

  const onSite = classifyRow({ title: 'QA Engineer', location: 'Bengaluru, India' }, { includeIndia: true });
  if (onSite.keep && onSite.rank === 3) pass('India on-site kept once enabled, ranked below Canada');
  else fail(`India on-site with toggle on: ${JSON.stringify(onSite)}`);

  const onRemote = classifyRow({ title: 'QA', location: 'Remote, India' }, { includeIndia: true });
  if (onRemote.keep && onRemote.rank === 0) pass('India remote ranks top when enabled');
  else fail(`India remote: ${JSON.stringify(onRemote)}`);

  // Enabling India must not disturb the existing policy.
  const ca = classifyRow({ title: 'QA', location: 'Toronto, ON' }, { includeIndia: true });
  const usOnsite = classifyRow({ title: 'QA', location: 'Austin, TX' }, { includeIndia: true });
  if (ca.keep && !usOnsite.keep) pass('Canada/US policy unchanged when India is enabled');
  else fail('enabling India altered the North America policy');

  // --- the toggle itself ----------------------------------------------------
  const dir = mkdtempSync(join(tmpdir(), 'india-'));
  const portals = join(dir, 'portals.yml');
  writeFileSync(portals, PORTALS_FIXTURE);

  const before = readIndiaState(portals);
  if (!before.enabled && before.portalEntries === 1 && before.enabledPortals === 0)
    pass('starts disabled, and finds the India portal entry under job_boards');
  else fail(`initial state wrong: ${JSON.stringify(before)}`);

  if (before.blockedTerms.includes('India')) pass('reports the location_filter terms that would block India');
  else fail('blocked terms not detected');

  setIndia(true, portals);
  const on = readIndiaState(portals);
  if (on.enabled && on.enabledPortals === 1 && on.blockedTerms.length === 0)
    pass('one command flips all three: opt-in, portal entry, location block');
  else fail(`after --on: ${JSON.stringify(on)}`);

  if (indiaEnabled(portals) === true) pass('geo-policy reads the toggle from the user\'s own portals.yml');
  else fail('indiaEnabled did not see the flag');

  // Unrelated config must survive a text-level edit.
  const text = readFileSync(portals, 'utf-8');
  if (/# search config/.test(text) && /recheck_after_days: 30/.test(text) && /- "Germany"/.test(text))
    pass('comments and unrelated blocks (Germany) survive the edit');
  else fail('toggle damaged the rest of portals.yml');

  if (/country: ca[\s\S]*?enabled: true/.test(text)) pass('the Canada entry is left alone');
  else fail('toggle touched the Canada portal entry');

  // --- lossless round-trip --------------------------------------------------
  setIndia(false, portals);
  const off = readIndiaState(portals);
  if (!off.enabled && off.enabledPortals === 0 && off.blockedTerms.includes('India'))
    pass('--off restores the disabled state exactly');
  else fail(`after --off: ${JSON.stringify(off)}`);

  const restored = readFileSync(portals, 'utf-8');
  const stripToggleLine = (s) => s.split('\n').filter((l) => !/^include_india:|^# Phase 8/.test(l) && l.trim() !== '').join('\n');
  if (stripToggleLine(restored) === stripToggleLine(PORTALS_FIXTURE))
    pass('on→off returns portals.yml byte-for-byte (quote style preserved)');
  else fail('round-trip altered the file');

  if (indiaEnabled(portals) === false) pass('geo-policy sees the toggle back off');
  else fail('stale toggle after --off');

  // A file with no India entry at all must not crash the toggle.
  const bare = join(dir, 'bare.yml');
  writeFileSync(bare, 'title_filter:\n  positive:\n    - qa\n');
  setIndia(true, bare);
  if (readIndiaState(bare).enabled) pass('toggle works on a portals.yml with no India entry yet');
  else fail('toggle failed on a minimal config');

  // --- auto-add a source when none is parseable (the live bug) --------------
  // A portals.yml with a working Adzuna Canada entry but NO India entry: /india
  // on must ADD a correctly-indented India source, not just flip a flag.
  const noIndia = join(dir, 'no-india.yml');
  writeFileSync(noIndia,
    'title_filter:\n  positive:\n    - qa\n\n' +
    'job_boards:\n' +
    '  - name: Adzuna Canada\n    provider: adzuna\n    country: ca\n    what: "qa"\n    enabled: true\n');
  setIndia(true, noIndia);
  const added = readIndiaState(noIndia);
  if (added.portalEntries === 1 && added.enabledPortals === 1)
    pass('/india on ADDS a parseable Adzuna India source when none exists');
  else fail(`auto-add failed: ${JSON.stringify(added)}`);

  // The added entry must be valid YAML that validate-portals accepts, and the
  // Canada entry must be untouched.
  const yaml2 = (await import('js-yaml')).default;
  const parsed = yaml2.load(readFileSync(noIndia, 'utf-8'));
  const inEntry = (parsed.job_boards || []).find((e) => e.country === 'in');
  const caEntry = (parsed.job_boards || []).find((e) => e.country === 'ca');
  if (inEntry && inEntry.provider === 'adzuna' && inEntry.enabled === true) pass('added India entry parses with the right fields');
  else fail(`added entry malformed: ${JSON.stringify(inEntry)}`);
  if (caEntry && caEntry.enabled === true) pass('the existing Canada entry is left intact');
  else fail('auto-add disturbed the Canada entry');

  // Idempotent: a second /india on must NOT add a duplicate.
  setIndia(true, noIndia);
  const twice = yaml2.load(readFileSync(noIndia, 'utf-8')).job_boards.filter((e) => e.country === 'in');
  if (twice.length === 1) pass('a second /india on does not duplicate the India source');
  else fail(`duplicate India entries after second toggle: ${twice.length}`);
} catch (err) {
  fail(`india-toggle test crashed: ${err.message}`);
}
