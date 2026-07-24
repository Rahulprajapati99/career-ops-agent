#!/usr/bin/env node

/**
 * india-toggle.mjs — Phase 8: turn Indian postings on or off for one user.
 *
 * India was deferred, not designed out: the Adzuna India portal entry already
 * ships (disabled), and the geography policy understands Indian locations. What
 * was missing is that enabling it took THREE coordinated edits in different
 * places — flip the portal entry, unblock "India" in location_filter, and opt
 * the geo policy in. Miss any one and the scan either finds nothing or finds
 * jobs that geo-policy silently drops. This makes it one command.
 *
 * Off by default, and per user: one family member can search India while the
 * others stay North-America-only.
 *
 * Usage:
 *   node india-toggle.mjs            # show current state
 *   node india-toggle.mjs --on       # include Indian postings
 *   node india-toggle.mjs --off      # back to North America only
 *   node india-toggle.mjs --json     # machine-readable state
 *
 * Run per user:  node run-as-user.mjs <id> india-toggle.mjs --on
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const USER_ROOT = process.env.CAREER_OPS_USER_ROOT
  ? resolve(process.env.CAREER_OPS_USER_ROOT)
  : process.cwd();

const PORTALS = process.env.CAREER_OPS_PORTALS || join(USER_ROOT, 'portals.yml');

/** Location-filter blocks that would exclude Indian postings before scoring. */
const INDIA_BLOCK_TERMS = ['india', 'bengaluru', 'bangalore', 'hyderabad', 'mumbai', 'pune', 'chennai',
  'gurgaon', 'gurugram', 'noida', 'delhi', 'kolkata', 'ahmedabad'];

/** Alternation used to rewrite those terms in the raw YAML text. */
const INDIA_TERM_RE = INDIA_BLOCK_TERMS.join('|');

/**
 * Every list in a portals.yml that can hold scan entries. Real user files use
 * `job_boards` + `tracked_companies`; the templates use `companies`/`portals`.
 * Checking only one key made the toggle silently report "0/0 entries".
 */
const ENTRY_KEYS = ['companies', 'portals', 'job_boards', 'tracked_companies'];

/**
 * Current India state for a portals file.
 *
 * @param {string} [portalsPath=PORTALS]
 * @returns {{enabled: boolean, portalEntries: number, blockedTerms: string[], exists: boolean}}
 */
export function readIndiaState(portalsPath = PORTALS) {
  if (!existsSync(portalsPath)) return { enabled: false, portalEntries: 0, blockedTerms: [], exists: false };
  const cfg = yaml.load(readFileSync(portalsPath, 'utf-8')) || {};
  const entries = ENTRY_KEYS
    .flatMap((k) => (Array.isArray(cfg[k]) ? cfg[k] : []))
    .filter((e) => String(e?.country || '').toLowerCase() === 'in');
  const blocked = (cfg.location_filter?.block || [])
    .filter((b) => INDIA_BLOCK_TERMS.includes(String(b).toLowerCase().trim()));
  return {
    enabled: cfg.include_india === true,
    portalEntries: entries.length,
    enabledPortals: entries.filter((e) => e.enabled !== false).length,
    blockedTerms: blocked,
    exists: true,
  };
}

/**
 * Flip the toggle by editing the YAML text.
 *
 * Text edits, not a yaml.dump round-trip: portals.yml is heavily commented and
 * those comments are the documentation a user reads when tuning their search.
 * Re-serializing would delete every one of them.
 *
 * @param {boolean} on
 * @param {string} [portalsPath=PORTALS]
 * @returns {{changed: string[]}}
 */
export function setIndia(on, portalsPath = PORTALS) {
  if (!existsSync(portalsPath)) throw new Error(`portals.yml not found at ${portalsPath}`);
  let text = readFileSync(portalsPath, 'utf-8');
  const changed = [];

  // 1. The geo-policy opt-in.
  if (/^include_india:.*$/m.test(text)) {
    const before = text;
    text = text.replace(/^include_india:.*$/m, `include_india: ${on}`);
    if (text !== before) changed.push(`include_india: ${on}`);
  } else {
    text = `# Phase 8 — include Indian postings (geo-policy + scan). Default false.\ninclude_india: ${on}\n\n${text}`;
    changed.push(`include_india: ${on} (added)`);
  }

  // 2. Every portal entry whose country is "in".
  //    Line-based on purpose: the multiline-regex version used `\Z`, which JS
  //    reads as a literal "Z", so the LAST entry in a file never matched — and
  //    the India entry is conventionally last.
  const lines = text.split('\n');
  const isItemStart = (l) => /^\s*-\s/.test(l);
  let flipped = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*country:\s*in\s*$/i.test(lines[i])) continue;
    const indent = lines[i].match(/^(\s*)/)[1];
    // Entry block = from here to the next list item (or end of file).
    let end = i + 1;
    while (end < lines.length && !isItemStart(lines[end])) end++;
    const enabledAt = lines.slice(i + 1, end).findIndex((l) => /^\s*enabled:\s*(true|false)\s*$/.test(l));
    if (enabledAt !== -1) lines[i + 1 + enabledAt] = `${indent}enabled: ${on}`;
    else lines.splice(i + 1, 0, `${indent}enabled: ${on}`);
    flipped++;
  }
  text = lines.join('\n');
  changed.push(`India portal entries: ${flipped} set to enabled=${on}`);

  // 3. The coarse keyword block that would drop Indian rows before scoring.
  // The quote style is carried through the commented form and restored on the
  // way back, so --on followed by --off returns the file byte-for-byte.
  if (on) {
    text = text.replace(new RegExp(String.raw`^(\s*)-\s*("?)(${INDIA_TERM_RE})\2\s*$`, 'gim'),
      (line, ind, quote, term) => `${ind}# - ${quote}${term}${quote}   # unblocked by india-toggle.mjs --on`);
    changed.push('location_filter block: India terms commented out');
  } else {
    text = text.replace(new RegExp(String.raw`^(\s*)#\s*-\s*("?)(${INDIA_TERM_RE})\2\s*#\s*unblocked by india-toggle\.mjs --on\s*$`, 'gim'),
      (line, ind, quote, term) => `${ind}- ${quote}${term}${quote}`);
    changed.push('location_filter block: India terms restored');
  }

  writeFileSync(portalsPath, text);
  return { changed };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const on = args.includes('--on');
  const off = args.includes('--off');

  if (on && off) {
    console.error('❌ Pass either --on or --off, not both.');
    process.exit(2);
  }

  if (on || off) {
    try {
      const { changed } = setIndia(on, PORTALS);
      console.log(`${on ? '🇮🇳 India ENABLED' : '🇨🇦 India disabled (North America only)'} for ${PORTALS}`);
      for (const c of changed) console.log(`   · ${c}`);
      console.log(on
        ? '\nRun /scan (or wait for the daily digest) to pull Indian postings.'
        : '\nExisting Indian rows stay in the pipeline until the next /scan.');
    } catch (e) {
      console.error(`❌ ${e.message}`);
      process.exit(1);
    }
  }

  const state = readIndiaState(PORTALS);
  if (args.includes('--json')) {
    console.log(JSON.stringify(state, null, 2));
  } else if (!on && !off) {
    if (!state.exists) console.log('No portals.yml for this user yet.');
    else {
      console.log(`India postings: ${state.enabled ? '🇮🇳 ENABLED' : 'disabled (North America only)'}`);
      console.log(`  India portal entries: ${state.enabledPortals}/${state.portalEntries} enabled`);
      if (state.blockedTerms.length) console.log(`  still blocked by location_filter: ${state.blockedTerms.join(', ')}`);
      console.log(`\nToggle with: node india-toggle.mjs ${state.enabled ? '--off' : '--on'}`);
    }
  }
}
