#!/usr/bin/env node

/**
 * add-job-sources.mjs — add the Y Combinator and Wellfound job sources to an
 * EXISTING user's portals.yml.
 *
 * Why this exists: templates/portals.family.yml only seeds users who don't have
 * a portals.yml yet (scaffold-user.mjs never overwrites one), and `users/` is
 * gitignored — so a new source added to the template reaches nobody who is
 * already set up, on any machine. This is the migration path for them.
 *
 * Idempotent: a source already present (in any shape) is reported and skipped,
 * so it is safe to re-run, and safe to run on every user including _global.
 *
 * Text insertion, not a yaml.dump round-trip: portals.yml is heavily commented
 * and those comments are the documentation a user reads when tuning their
 * search. Re-serializing would delete every one of them. (Same reasoning, and
 * the same anchor logic, as india-toggle.mjs.)
 *
 * Usage:
 *   node add-job-sources.mjs                 # report what's present / missing
 *   node add-job-sources.mjs --add           # add every missing source
 *   node add-job-sources.mjs --add yc        # add just one (yc | wellfound)
 *   node add-job-sources.mjs --add --dry-run # print the result, write nothing
 *   node add-job-sources.mjs --json          # machine-readable state
 *
 * Run per user:  node run-as-user.mjs <id> add-job-sources.mjs --add
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const USER_ROOT = process.env.CAREER_OPS_USER_ROOT
  ? resolve(process.env.CAREER_OPS_USER_ROOT)
  : process.cwd();

const PORTALS = process.env.CAREER_OPS_PORTALS || join(USER_ROOT, 'portals.yml');

/** Every list in a portals.yml that can hold scan entries (see india-toggle.mjs). */
const ENTRY_KEYS = ['companies', 'portals', 'job_boards', 'tracked_companies'];

/**
 * The sources this migration can add.
 *
 * `has` decides idempotency, and deliberately matches on the MECHANISM rather
 * than the entry name: a user who wired Wellfound up by hand under a different
 * label must not get a second, duplicate entry.
 *
 * @type {Record<string, {label: string, has: (cfg: any) => boolean, block: (indent: string) => string[]}>}
 */
export const SOURCES = {
  yc: {
    label: 'Y Combinator',
    has: (cfg) => entriesOf(cfg).some((e) => String(e?.provider || '').toLowerCase() === 'ycombinator'),
    block: (i) => [
      `${i}- name: Y Combinator`,
      `${i}  careers_url: https://www.ycombinator.com/jobs`,
      `${i}  provider: ycombinator`,
      `${i}  roles: [eng, product, operations]   # CUSTOMIZE — omit for all 11 categories`,
      `${i}  max_jobs: 500`,
      `${i}  enabled: true`,
      `${i}  notes: "YC / Work at a Startup postings — zero-auth"`,
      '',
    ],
  },
  communitech: {
    label: 'Communitech (Waterloo region)',
    has: (cfg) => entriesOf(cfg).some((e) => String(e?.provider || '').toLowerCase() === 'communitech'),
    block: (i) => [
      `${i}# Communitech — Waterloo-region Canadian tech board. Zero-auth, no key,`,
      `${i}# and it publishes salary in CAD for about half its postings. It does`,
      `${i}# not server-render pagination, so coverage comes from queries: — one`,
      `${i}# request per term, ~20 postings each.`,
      `${i}- name: Communitech`,
      `${i}  careers_url: https://www1.communitech.ca/jobs`,
      `${i}  provider: communitech`,
      `${i}  queries: ["qa", "quality assurance", "test automation"]   # CUSTOMIZE`,
      `${i}  max_jobs: 200`,
      `${i}  enabled: true`,
      `${i}  notes: "Waterloo-region Canadian tech jobs — zero-auth, often lists salary"`,
      '',
    ],
  },
  wellfound: {
    label: 'Wellfound',
    // Wellfound is reached THROUGH serpapi's via: filter, so that pairing — not
    // the entry name — is what "already has Wellfound" means.
    has: (cfg) => entriesOf(cfg).some(
      (e) => String(e?.provider || '').toLowerCase() === 'serpapi'
        && String(e?.via || '').toLowerCase().replace(/[^a-z0-9]/g, '') === 'wellfound',
    ),
    block: (i) => [
      `${i}# Wellfound (ex-AngelList) blocks automated access — every endpoint`,
      `${i}# answers HTTP 403 and robots.txt disallows the job paths, and there is`,
      `${i}# no public API. Google DOES index its postings, so they are scanned`,
      `${i}# through Google Jobs with the via: source filter. Needs a SerpApi key`,
      `${i}# (/setkey serpapi <key>); without one this entry just skips quietly.`,
      `${i}- name: Wellfound`,
      `${i}  provider: serpapi`,
      `${i}  q: "startup software engineer"   # CUSTOMIZE — keep BROAD, via: narrows it`,
      `${i}  location: "United States"`,
      `${i}  via: Wellfound`,
      `${i}  max_pages: 1`,
      `${i}  enabled: true`,
      `${i}  notes: "Wellfound/AngelList postings via Google Jobs — needs SERPAPI key"`,
      '',
    ],
  },
};

/** Flatten every entry list in a parsed portals config. */
function entriesOf(cfg) {
  return ENTRY_KEYS.flatMap((k) => (Array.isArray(cfg?.[k]) ? cfg[k] : []));
}

/**
 * Which sources a portals file already has.
 *
 * @param {string} [portalsPath=PORTALS]
 * @returns {{exists: boolean, present: string[], missing: string[]}}
 */
export function readSourceState(portalsPath = PORTALS) {
  if (!existsSync(portalsPath)) return { exists: false, present: [], missing: Object.keys(SOURCES) };
  let cfg;
  try {
    cfg = yaml.load(readFileSync(portalsPath, 'utf-8')) || {};
  } catch (err) {
    throw new Error(`${portalsPath} is not valid YAML — fix it before adding sources (${err.message})`);
  }
  const present = [];
  const missing = [];
  for (const [id, src] of Object.entries(SOURCES)) (src.has(cfg) ? present : missing).push(id);
  return { exists: true, present, missing };
}

/**
 * Find where a new job_boards item should go, and with what indentation.
 *
 * Prefers to copy the indentation of the first existing item under
 * `job_boards:` — hand-guessed nesting is the most common way an added entry
 * ends up invisible to yaml. Returns insertAt = -1 when there is no
 * job_boards list at all (caller appends one).
 *
 * Exported for tests.
 * @param {string[]} lines
 * @returns {{insertAt: number, indent: string}}
 */
export function findInsertPoint(lines) {
  const listIdx = lines.findIndex((l) => /^job_boards:\s*$/.test(l));
  if (listIdx === -1) return { insertAt: -1, indent: '  ' };

  // First `- name:` after the header, before the next top-level key, sets indent.
  for (let i = listIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^[A-Za-z_][\w-]*:/.test(line)) break; // next top-level key → list is over
    const m = line.match(/^(\s+)-\s/);
    if (m) return { insertAt: i, indent: m[1] };
  }
  return { insertAt: listIdx + 1, indent: '  ' };
}

/**
 * Add the requested sources to the portals YAML text.
 *
 * Sources already present are skipped. The result is parsed before being
 * returned; if the edit somehow produced YAML that no longer loads, or in which
 * the new entries aren't visible as job_boards items, it throws instead of
 * handing back a broken config.
 *
 * @param {string} text                Current portals.yml contents.
 * @param {string[]} [ids]             Source ids to add (default: all).
 * @returns {{text: string, added: string[], skipped: string[]}}
 */
export function addSources(text, ids = Object.keys(SOURCES)) {
  const wanted = ids.filter((id) => SOURCES[id]);
  if (wanted.length === 0) throw new Error(`no known sources requested (valid: ${Object.keys(SOURCES).join(', ')})`);

  let cfg;
  try {
    cfg = yaml.load(text) || {};
  } catch (err) {
    throw new Error(`portals.yml is not valid YAML — fix it first (${err.message})`);
  }

  const added = [];
  const skipped = [];
  let lines = text.split('\n');

  for (const id of wanted) {
    if (SOURCES[id].has(cfg)) { skipped.push(id); continue; }

    const { insertAt, indent } = findInsertPoint(lines);
    const block = SOURCES[id].block(indent);
    if (insertAt === -1) {
      // No job_boards list yet — start one at the end of the file.
      lines = [...lines, '', 'job_boards:', ...SOURCES[id].block('  ')];
    } else {
      lines.splice(insertAt, 0, ...block);
    }
    added.push(id);

    // Re-parse so the next source's `has()` sees this one (and so a broken
    // insertion is caught on the very step that caused it).
    const next = lines.join('\n');
    try {
      cfg = yaml.load(next) || {};
    } catch (err) {
      throw new Error(`adding ${id} produced invalid YAML — aborting (${err.message})`);
    }
    if (!SOURCES[id].has(cfg)) {
      throw new Error(`adding ${id} did not register as a job_boards entry — aborting rather than writing a config that scans nothing`);
    }
  }

  return { text: lines.join('\n'), added, skipped };
}

// ── CLI ─────────────────────────────────────────────────────────────

function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const doAdd = args.includes('--add');

  // `--add yc` / `--add yc,wellfound` — bare ids after the flag.
  const ids = args
    .filter((a) => !a.startsWith('--'))
    .flatMap((a) => a.split(','))
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  const unknown = ids.filter((id) => !SOURCES[id]);
  if (unknown.length) {
    console.error(`Unknown source(s): ${unknown.join(', ')}. Valid: ${Object.keys(SOURCES).join(', ')}`);
    process.exit(1);
  }
  const wanted = ids.length ? ids : Object.keys(SOURCES);

  let state;
  try {
    state = readSourceState();
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  if (!state.exists) {
    const msg = `no portals.yml at ${PORTALS} — scaffold the user first (node scaffold-user.mjs <id>)`;
    if (json) console.log(JSON.stringify({ portals: PORTALS, exists: false, error: msg }));
    else console.error(`❌ ${msg}`);
    process.exit(1);
  }

  if (!doAdd) {
    if (json) console.log(JSON.stringify({ portals: PORTALS, ...state }));
    else {
      console.log(`portals: ${PORTALS}`);
      for (const [id, src] of Object.entries(SOURCES)) {
        console.log(`  ${state.present.includes(id) ? '✅' : '⬜'} ${src.label} (${id})`);
      }
      if (state.missing.length) console.log(`\nAdd them with:  node add-job-sources.mjs --add`);
    }
    return;
  }

  let result;
  try {
    result = addSources(readFileSync(PORTALS, 'utf-8'), wanted);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  if (dryRun) {
    if (json) console.log(JSON.stringify({ portals: PORTALS, dryRun: true, ...result, text: undefined }));
    else {
      console.log(`(dry run — nothing written)`);
      console.log(`  would add:  ${result.added.join(', ') || '(none)'}`);
      console.log(`  already there: ${result.skipped.join(', ') || '(none)'}`);
    }
    return;
  }

  if (result.added.length) writeFileSync(PORTALS, result.text);

  if (json) console.log(JSON.stringify({ portals: PORTALS, added: result.added, skipped: result.skipped }));
  else {
    for (const id of result.added) console.log(`✅ added ${SOURCES[id].label}`);
    for (const id of result.skipped) console.log(`⏭️  ${SOURCES[id].label} already configured`);
    if (result.added.length) console.log(`\nWrote ${PORTALS}. Run /scan (or node scan.mjs) to pull from the new sources.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv);
