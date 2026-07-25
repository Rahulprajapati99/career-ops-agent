#!/usr/bin/env node

/**
 * job-prefs.mjs — point one user's scan at THEIR roles.
 *
 * Every user's portals.yml starts from templates/portals.family.yml, whose
 * search terms are the seed default "software engineer" and whose title filter
 * is the generic engineer/developer/analyst/manager. Left alone, a QA lead and
 * an HR manager both get a pipeline full of backend jobs — the scan was never
 * wrong, it was just never told who it was scanning for.
 *
 * This writes, into users/<id>/portals.yml:
 *   · title_filter.positive  — the roles that user actually wants
 *   · title_filter.negative  — merged with the shared global_negative list
 *   · max_posting_age_days   — the 7-day house rule
 *   · Adzuna  what → what_or — ANY of the preset's keywords (one request)
 *   · SerpApi q              — the preset's OR-joined Google Jobs query
 *   · Y Combinator roles     — the preset's YC categories
 *
 * Edits are line-level TEXT surgery, not a YAML round-trip: portals.yml's
 * comments are its user-facing documentation, and js-yaml would silently delete
 * every one of them. Same idiom as india-toggle.mjs and add-job-sources.mjs.
 * Re-running is idempotent.
 *
 * Usage:
 *   node job-prefs.mjs list                        # available presets
 *   node job-prefs.mjs show <user>                 # what that user searches for now
 *   node job-prefs.mjs set <user> --preset qa-ai
 *   node job-prefs.mjs set <user> --titles "senior qa, qa lead"
 *   node job-prefs.mjs set <user> --preset hr-talent --dry-run
 *
 * <user> is a users/<id> folder name, or any unique SUFFIX of one ("7091").
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { REPO_ROOT, userRootFor } from './user-env.mjs';

const PRESETS_PATH = join(REPO_ROOT, 'templates', 'role-presets.yml');
const USERS_DIR = join(REPO_ROOT, 'users');
const MAX_POSTING_AGE_DAYS = 7;

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------
/** Load templates/role-presets.yml. Exported for tests. */
export function loadPresets(path = PRESETS_PATH) {
  if (!existsSync(path)) throw new Error(`role presets not found at ${path}`);
  const raw = yaml.load(readFileSync(path, 'utf-8')) || {};
  const presets = raw.presets && typeof raw.presets === 'object' ? raw.presets : {};
  const globalNegative = Array.isArray(raw.global_negative) ? raw.global_negative : [];
  return { presets, globalNegative };
}

/**
 * Resolve a user reference to exactly one users/<id> folder. Accepts the full
 * id or any unique suffix, so an operator can say "8910" without looking the
 * full Telegram id up. Ambiguity is an error, never a guess.
 *
 * @param {string} ref
 * @param {string[]} ids - existing user folder names
 * @returns {string}
 */
export function resolveUserId(ref, ids) {
  const wanted = String(ref || '').trim();
  if (!wanted) throw new Error('no user given');
  if (ids.includes(wanted)) return wanted;
  const matches = ids.filter((id) => id.endsWith(wanted));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`no user matches "${wanted}" (have: ${ids.join(', ') || 'none'})`);
  throw new Error(`"${wanted}" matches ${matches.length} users: ${matches.join(', ')} — pass the full id`);
}

/** users/<id> folder names, minus the shared job-pool pseudo-user. */
export function listUserIds(usersDir = USERS_DIR) {
  if (!existsSync(usersDir)) return [];
  return readdirSync(usersDir).filter((f) => statSync(join(usersDir, f)).isDirectory());
}

// ---------------------------------------------------------------------------
// YAML text surgery — comment-preserving
// ---------------------------------------------------------------------------
/** Double-quote a scalar so titles with `:` or `#` survive as one YAML value. */
function q(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Slice out a top-level `key:` block (the key line plus every indented line
 * under it) and hand it to `transform`. Returns the rebuilt document, or null
 * when the key is absent. Exported for tests.
 */
export function editTopLevelBlock(text, key, transform) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (start === -1) return null;
  let end = start + 1;
  // The block runs until the next line that starts in column 0. Blank lines are
  // absorbed so a trailing gap does not cut the block short.
  while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) end += 1;
  const replaced = transform(lines.slice(start, end).join('\n'));
  if (replaced == null) return null;
  return [...lines.slice(0, start), ...replaced.split('\n'), ...lines.slice(end)].join('\n');
}

/**
 * Replace the item list under `  <subkey>:` inside an already-sliced block.
 * Keeps the subkey line, its indentation, and everything after the list.
 * Exported for tests.
 */
export function replaceListUnder(block, subkey, items) {
  const lines = block.split('\n');
  const i = lines.findIndex((l) => new RegExp(`^\\s+${subkey}:\\s*$`).test(l));
  if (i === -1) return null;
  const indent = lines[i].match(/^\s*/)[0];
  let end = i + 1;
  while (end < lines.length && /^\s*-\s/.test(lines[end])) end += 1;
  const rendered = items.map((item) => `${indent}  - ${q(item)}`);
  return [...lines.slice(0, i + 1), ...rendered, ...lines.slice(end)].join('\n');
}

/**
 * Read the item list under `  <subkey>:` inside a sliced block. Scoped to that
 * one sub-list: scraping every `- item` line out of the block would sweep up
 * the positive list too and treat those roles as exclusions. Exported for tests.
 *
 * @param {string} block
 * @param {string} subkey
 * @returns {string[]}
 */
export function readListUnder(block, subkey) {
  const lines = block.split('\n');
  const i = lines.findIndex((l) => new RegExp(`^\\s+${subkey}:\\s*$`).test(l));
  if (i === -1) return [];
  const items = [];
  for (let j = i + 1; j < lines.length && /^\s*-\s/.test(lines[j]); j += 1) {
    const raw = lines[j].replace(/^\s*-\s*/, '').replace(/\s+#.*$/, '').trim();
    const unquoted = raw.replace(/^["'](.*)["']$/, '$1').trim();
    if (unquoted) items.push(unquoted);
  }
  return items;
}

/**
 * Set a top-level scalar, inserting it near the top when absent.
 * Exported for tests.
 */
export function setTopLevelScalar(text, key, value) {
  const re = new RegExp(`^${key}:[ \\t]*.*$`, 'm');
  if (re.test(text)) return text.replace(re, `${key}: ${value}`);
  const lines = text.split('\n');
  // After the leading comment banner, before the first real key.
  let at = lines.findIndex((l) => /^[A-Za-z_]/.test(l));
  if (at === -1) at = lines.length;
  return [...lines.slice(0, at), `${key}: ${value}`, '', ...lines.slice(at)].join('\n');
}

/**
 * Set a top-level LIST key (e.g. `priority_titles:`), replacing it wholesale
 * when present and inserting it after the comment banner when absent.
 *
 * Whole-list replacement is right here (unlike title_filter.negative, which is
 * merged): priority_titles IS the preset's target list, so switching presets
 * must not leave the previous track's roles floating at the top of the pipeline.
 * Exported for tests.
 *
 * @param {string} text
 * @param {string} key
 * @param {string[]} items
 * @param {string} [comment] Optional comment line written above a NEW key.
 */
export function setTopLevelList(text, key, items, comment = '') {
  const body = items.map((v) => `  - ${/[:#'"]/.test(v) ? JSON.stringify(v) : v}`);
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^${key}:[ \\t]*$`).test(l));
  if (start !== -1) {
    // Replace through the end of the existing block (list items + comments).
    let end = start + 1;
    while (end < lines.length && (/^[ \t]+-[ \t]/.test(lines[end]) || /^[ \t]*#/.test(lines[end]) || lines[end].trim() === '')) {
      // Stop at a blank line that is followed by a new top-level key.
      if (lines[end].trim() === '' && /^[A-Za-z_]/.test(lines[end + 1] || '')) break;
      end += 1;
    }
    return [...lines.slice(0, start), `${key}:`, ...body, ...lines.slice(end)].join('\n');
  }
  let at = lines.findIndex((l) => /^[A-Za-z_]/.test(l));
  if (at === -1) at = lines.length;
  const block = [...(comment ? [comment] : []), `${key}:`, ...body, ''];
  return [...lines.slice(0, at), ...block, ...lines.slice(at)].join('\n');
}

/**
 * Rewrite the per-source search terms. Adzuna's `what` (ALL words) becomes
 * `what_or` (ANY word) so one request covers a whole role family; SerpApi's `q`
 * takes the OR-joined query; YC's `roles` list takes the preset's categories.
 * Exported for tests.
 */
export function setSearchQueries(text, { searchAny, googleQuery, ycRoles }) {
  let out = text;
  // Each pattern ends by capturing an optional trailing `# comment` and the
  // replacement puts it back: those inline "# CUSTOMIZE" notes are how a user
  // knows which lines are theirs to edit, and swallowing them would quietly
  // strip the file's documentation one command at a time.
  const VALUE = '(?:"[^"]*"|\'[^\']*\'|[^#\\n]*)';
  if (searchAny) {
    // `what:` → `what_or:` on first run; `what_or:` value swap on every later one.
    out = out.replace(
      new RegExp(`^([ \\t]+)what(?:_or)?:[ \\t]*${VALUE}([ \\t]*#.*)?$`, 'gm'),
      `$1what_or: ${q(searchAny)}$2`,
    );
  }
  if (googleQuery) {
    out = out.replace(
      new RegExp(`^([ \\t]+)q:[ \\t]*${VALUE}([ \\t]*#.*)?$`, 'gm'),
      `$1q: ${q(googleQuery)}$2`,
    );
  }
  if (Array.isArray(ycRoles) && ycRoles.length > 0) {
    out = out.replace(
      /^([ \t]+)roles:[ \t]*\[[^\]]*\]([ \t]*#.*)?$/gm,
      `$1roles: [${ycRoles.join(', ')}]$2`,
    );
  }
  return out;
}

/**
 * Apply a preset to a portals.yml document. Pure — exported for tests.
 *
 * @param {string} text - current portals.yml
 * @param {{filter: string[], search_any?: string, google_query?: string, yc_roles?: string[]}} preset
 * @param {string[]} [globalNegative]
 * @returns {{ text: string, warnings: string[] }}
 */
export function applyPreset(text, preset, globalNegative = []) {
  const warnings = [];
  let out = text;

  const positives = (preset.filter || []).map((s) => String(s).trim()).filter(Boolean);
  if (positives.length === 0) throw new Error('preset has no `filter` keywords');

  const withTitles = editTopLevelBlock(out, 'title_filter', (block) => {
    let b = replaceListUnder(block, 'positive', positives);
    if (b == null) return null;
    // Merge rather than replace: a user's own exclusions (junior, co-op,
    // graduate…) are deliberate and outlive a preset switch. Read from the
    // `negative:` sub-list ONLY — the positive list lives in the same block.
    const existingNegative = readListUnder(block, 'negative');
    const seenLower = new Set();
    const negatives = [...existingNegative, ...globalNegative].filter((v) => {
      const k = v.toLowerCase();
      if (seenLower.has(k)) return false;
      seenLower.add(k);
      return true;
    });
    const withNeg = replaceListUnder(b, 'negative', negatives);
    if (withNeg != null) b = withNeg;
    return b;
  });
  if (withTitles == null) warnings.push('no `title_filter:` block found — title filter unchanged');
  else out = withTitles;

  out = setTopLevelScalar(out, 'max_posting_age_days', String(MAX_POSTING_AGE_DAYS));

  // The preset's target roles drive pipeline ORDER (geo-policy floats them to
  // the top, newest-first inside the block). Without this the user's own titles
  // would rank no higher than any other posting the filter admits.
  const priority = (preset.titles || []).map((s) => String(s).trim()).filter(Boolean);
  if (priority.length) {
    out = setTopLevelList(out, 'priority_titles', priority,
      '# Target roles — floated to the TOP of the pipeline (newest-first within),'
      + '\n# everything else the filter admits follows below. Written by job-prefs.mjs.');
  }

  // Salary floor, when the preset sets one. Only drops postings that STATE pay
  // below it; rows with no salary shown are kept.
  if (Number.isFinite(Number(preset.min_salary)) && Number(preset.min_salary) > 0) {
    out = setTopLevelScalar(out, 'min_salary', String(Math.trunc(Number(preset.min_salary))));
  }

  out = setSearchQueries(out, {
    searchAny: preset.search_any,
    googleQuery: preset.google_query,
    ycRoles: preset.yc_roles,
  });

  return { text: out, warnings };
}

/** Read back what a portals.yml currently searches for. Exported for tests. */
export function summarize(text) {
  const cfg = yaml.load(text) || {};
  const boards = Array.isArray(cfg.job_boards) ? cfg.job_boards : [];
  return {
    positive: cfg.title_filter?.positive ?? [],
    negative: cfg.title_filter?.negative ?? [],
    maxPostingAgeDays: cfg.max_posting_age_days ?? null,
    includeIndia: cfg.include_india === true,
    queries: [...new Set(boards.map((b) => b?.what_or || b?.what || b?.q).filter(Boolean))],
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function flagValue(args, name) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  try {
    const { presets, globalNegative } = loadPresets();

    if (!cmd || cmd === 'list' || cmd === '--help' || cmd === '-h') {
      console.log('\nRole presets (templates/role-presets.yml):\n');
      for (const [name, p] of Object.entries(presets)) {
        console.log(`  ${name.padEnd(22)} ${p.label || ''}`);
        console.log(`  ${' '.repeat(22)} filter: ${(p.filter || []).join(', ')}`);
      }
      console.log('\nUsage: node job-prefs.mjs set <user> --preset <name>');
      console.log('       node job-prefs.mjs set <user> --titles "senior qa, qa lead"');
      console.log('       node job-prefs.mjs show <user>\n');
      process.exit(0);
    }

    const ids = listUserIds();
    const userId = resolveUserId(args[1], ids);
    const portalsPath = join(userRootFor(userId), 'portals.yml');
    if (!existsSync(portalsPath)) {
      throw new Error(`no portals.yml for ${userId} — run: node scaffold-user.mjs ${userId}`);
    }
    const current = readFileSync(portalsPath, 'utf-8');

    if (cmd === 'show') {
      const s = summarize(current);
      console.log(`\n👤 ${userId}`);
      console.log(`   titles     : ${s.positive.join(', ') || '(none)'}`);
      console.log(`   excluded   : ${s.negative.join(', ') || '(none)'}`);
      console.log(`   max age    : ${s.maxPostingAgeDays ?? 'unset'} days`);
      console.log(`   India      : ${s.includeIndia ? 'on' : 'off'}`);
      console.log(`   queries    : ${s.queries.join(' · ') || '(none)'}\n`);
      process.exit(0);
    }

    if (cmd !== 'set') throw new Error(`unknown command "${cmd}" (expected list|show|set)`);

    const presetName = flagValue(args, '--preset');
    const titlesArg = flagValue(args, '--titles');
    const fromCv = args.includes('--from-cv');
    if (!presetName && !titlesArg && !fromCv) {
      throw new Error('pass --preset <name>, --titles "a, b, c", or --from-cv');
    }

    let preset;
    if (fromCv) {
      // Derive the search from this user's OWN résumé. The named presets describe
      // specific people; a new member from another field needs their own profile,
      // not somebody else's role list. Preset-shaped, so it applies identically.
      const cvPath = join(dirname(portalsPath), 'cv.md');
      if (!existsSync(cvPath)) throw new Error(`no résumé at ${cvPath} — the user must upload one first`);
      const { derivePrefsFromCv } = await import('./derive-prefs.mjs');
      preset = derivePrefsFromCv(readFileSync(cvPath, 'utf-8'));
      if (!preset.confident) {
        throw new Error('could not read enough job titles from that résumé to aim a scan — set them explicitly with --titles "a, b, c"');
      }
      console.log(`📄 Derived from cv.md: ${preset.titles.join(' · ')}`);
    } else if (presetName) {
      preset = presets[presetName];
      if (!preset) throw new Error(`unknown preset "${presetName}" (have: ${Object.keys(presets).join(', ')})`);
    } else {
      const filter = titlesArg.split(',').map((s) => s.trim()).filter(Boolean);
      preset = { label: 'custom', filter, search_any: filter.join(' ') };
    }

    const { text, warnings } = applyPreset(current, preset, globalNegative);
    for (const w of warnings) console.warn(`⚠️  ${w}`);

    if (args.includes('--dry-run')) {
      console.log(text);
      process.exit(0);
    }
    if (text === current) {
      console.log(`✅ ${userId} already set to ${presetName || 'those titles'} — nothing to change.`);
      process.exit(0);
    }
    writeFileSync(portalsPath, text, 'utf-8');
    const s = summarize(text);
    console.log(`✅ ${userId} → ${preset.label || presetName}`);
    console.log(`   titles  : ${s.positive.join(', ')}`);
    console.log(`   queries : ${s.queries.join(' · ') || '(none)'}`);
    console.log(`   max age : ${s.maxPostingAgeDays} days`);
    console.log('\n   Next scan picks this up — run /scan in Telegram, or:');
    console.log(`   node run-as-user.mjs ${userId} scan.mjs`);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}
