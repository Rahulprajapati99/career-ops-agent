// tests/add-job-sources.test.mjs — the migration that adds the YC + Wellfound
// sources to an EXISTING user's portals.yml. Pure text/YAML work, no network.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import yaml from 'js-yaml';

console.log('\nadd-job-sources.mjs');

try {
  const { SOURCES, addSources, findInsertPoint } = await import(
    pathToFileURL(join(ROOT, 'add-job-sources.mjs')).href
  );

  // A realistic, comment-heavy portals.yml (comments are the user-facing docs).
  const BASE = [
    '# ── My search ──',
    'title_filter:',
    '  positive:',
    '    - engineer',
    '',
    '# ── Aggregator feeds ──',
    'job_boards:',
    '',
    '  # The Muse — zero-auth',
    '  - name: The Muse',
    '    provider: themuse',
    '    enabled: true',
    '',
    'tracked_companies:',
    '  - name: Stripe',
    '    careers_url: https://stripe.com/jobs',
    '',
  ].join('\n');

  // Asserted STRUCTURALLY, not against a hardcoded id list: this test is about
  // the registry's shape, so adding a migration (communitech, …) must not fail it.
  const ALL_IDS = Object.keys(SOURCES).sort();
  const malformed = ALL_IDS.filter((id) => {
    const s = SOURCES[id];
    return !s || typeof s.label !== 'string' || typeof s.has !== 'function'
      || typeof s.block !== 'function' || !Array.isArray(s.block('  '));
  });
  if (ALL_IDS.length >= 2 && malformed.length === 0)
    pass(`SOURCES exposes ${ALL_IDS.length} well-formed migrations (${ALL_IDS.join(', ')})`);
  else fail(`malformed: ${JSON.stringify(malformed)} of ${JSON.stringify(ALL_IDS)}`);

  // ── findInsertPoint ───────────────────────────────────────────────
  const fip = findInsertPoint(BASE.split('\n'));
  if (fip.indent === '  ' && BASE.split('\n')[fip.insertAt].includes('- name: The Muse'))
    pass('findInsertPoint() targets the first job_boards item and copies its indent');
  else fail(`findInsertPoint() = ${JSON.stringify(fip)}`);

  if (findInsertPoint(['title_filter:', '  positive: []']).insertAt === -1)
    pass('findInsertPoint() reports -1 when there is no job_boards list');
  else fail('findInsertPoint() should return -1 without a job_boards list');

  // Indentation is copied, not assumed: a 4-space file must stay 4-space.
  const wide = ['job_boards:', '    - name: X', '      provider: themuse', ''].join('\n');
  if (findInsertPoint(wide.split('\n')).indent === '    ')
    pass('findInsertPoint() copies a non-standard indent instead of forcing two spaces');
  else fail(`findInsertPoint() wide indent = ${JSON.stringify(findInsertPoint(wide.split('\n')).indent)}`);

  // ── addSources ────────────────────────────────────────────────────
  const out = addSources(BASE);
  const cfg = yaml.load(out.text);

  if (out.added.sort().join(',') === ALL_IDS.join(',') && out.skipped.length === 0)
    pass(`addSources() adds every source to a config that has none (${out.added.length})`);
  else fail(`addSources() added=${JSON.stringify(out.added)} skipped=${JSON.stringify(out.skipped)}`);

  const yc = (cfg.job_boards || []).find((e) => e.provider === 'ycombinator');
  if (yc && yc.careers_url === 'https://www.ycombinator.com/jobs' && yc.enabled === true && Array.isArray(yc.roles))
    pass('addSources() writes a YC entry yaml can actually see');
  else fail(`YC entry = ${JSON.stringify(yc)}`);

  const wf = (cfg.job_boards || []).find((e) => e.provider === 'serpapi' && e.via === 'Wellfound');
  if (wf && wf.enabled === true && typeof wf.q === 'string')
    pass('addSources() writes a Wellfound entry routed through serpapi via:');
  else fail(`Wellfound entry = ${JSON.stringify(wf)}`);

  if ((cfg.job_boards || []).some((e) => e.provider === 'themuse')
      && (cfg.tracked_companies || []).some((e) => e.name === 'Stripe'))
    pass('addSources() leaves existing entries intact');
  else fail('addSources() lost an existing entry');

  if (out.text.includes('# ── Aggregator feeds ──') && out.text.includes('# The Muse — zero-auth')
      && out.text.includes('# ── My search ──'))
    pass('addSources() preserves the file\'s comments (no yaml.dump round-trip)');
  else fail('addSources() dropped comments');

  // ── Idempotency ───────────────────────────────────────────────────
  const again = addSources(out.text);
  if (again.added.length === 0 && again.skipped.sort().join(',') === ALL_IDS.join(','))
    pass('addSources() is idempotent — a second run adds nothing');
  else fail(`second run added ${JSON.stringify(again.added)}`);

  if (again.text === out.text)
    pass('addSources() leaves the file byte-identical when nothing is missing');
  else fail('idempotent run still modified the text');

  const twice = yaml.load(again.text).job_boards.filter((e) => e.provider === 'ycombinator');
  if (twice.length === 1) pass('addSources() never creates a duplicate YC entry');
  else fail(`found ${twice.length} YC entries after re-running`);

  // Idempotency keys on the MECHANISM, not the entry name.
  const renamed = [
    'job_boards:',
    '  - name: Startup jobs (my own label)',
    '    provider: serpapi',
    '    q: "founding engineer"',
    '    via: wellfound',
    '',
  ].join('\n');
  const r = addSources(renamed, ['wellfound']);
  if (r.added.length === 0 && r.skipped[0] === 'wellfound')
    pass('addSources() recognizes a hand-wired Wellfound entry under a different name');
  else fail(`renamed-entry run added ${JSON.stringify(r.added)}`);

  // ── Selective + edge cases ────────────────────────────────────────
  const only = addSources(BASE, ['yc']);
  const onlyCfg = yaml.load(only.text);
  if (only.added.join(',') === 'yc'
      && onlyCfg.job_boards.some((e) => e.provider === 'ycombinator')
      && !onlyCfg.job_boards.some((e) => e.via === 'Wellfound'))
    pass('addSources() can add a single requested source');
  else fail(`selective add = ${JSON.stringify(only.added)}`);

  // No job_boards list at all → one is created.
  const bare = 'title_filter:\n  positive:\n    - engineer\n';
  const bareOut = addSources(bare, ['yc']);
  const bareCfg = yaml.load(bareOut.text);
  if (Array.isArray(bareCfg.job_boards) && bareCfg.job_boards.some((e) => e.provider === 'ycombinator')
      && Array.isArray(bareCfg.title_filter.positive))
    pass('addSources() creates a job_boards list when the file has none');
  else fail(`bare-config result = ${JSON.stringify(bareCfg)}`);

  // A 4-space file stays valid after insertion.
  const wideOut = addSources(wide, ['yc']);
  if (yaml.load(wideOut.text).job_boards.some((e) => e.provider === 'ycombinator'))
    pass('addSources() inserts correctly into a non-standard-indent file');
  else fail('non-standard indent insertion produced an unreadable entry');

  // Malformed input must fail loudly, not silently rewrite the file.
  let threw = false;
  try { addSources('job_boards:\n  - name: [unclosed\n'); } catch { threw = true; }
  if (threw) pass('addSources() refuses to edit a portals.yml that is not valid YAML');
  else fail('addSources() should throw on malformed YAML');

  let threwUnknown = false;
  try { addSources(BASE, ['nope']); } catch { threwUnknown = true; }
  if (threwUnknown) pass('addSources() rejects an unknown source id');
  else fail('addSources() should throw for an unknown source id');

} catch (e) {
  fail(`add-job-sources tests crashed: ${e.message}`);
}
