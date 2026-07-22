#!/usr/bin/env node

/**
 * scaffold-user.mjs — Family Edition: create (or repair) a per-user data root
 * under users/<id>/ with the standard user-layer skeleton.
 *
 * Seeds, in order of preference, from the repo's example files:
 *   config/profile.yml   ← config/profile.example.yml
 *   config/cv-facts.json ← config/cv-facts.example.json
 *   portals.yml          ← templates/portals.example.yml
 *   cv.md                ← placeholder pointing at examples/cv-example.md
 *
 * Existing files are NEVER overwritten (safe to re-run; also used to migrate:
 * pass --from <dir> to copy an existing single-user layer in).
 *
 * Usage:
 *   node scaffold-user.mjs <userId>              # fresh skeleton
 *   node scaffold-user.mjs <userId> --from .     # migrate repo-root user data in
 *   node scaffold-user.mjs _global               # shared job-pool pseudo-user
 */

import {
  mkdirSync, existsSync, copyFileSync, writeFileSync, readdirSync, statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, userRootFor } from './user-env.mjs';

const SKELETON_DIRS = ['config', 'data', 'data/offers', 'data/parser-output', 'reports', 'output', 'jds', 'interview-prep', 'interview-prep/sessions'];

/** Copy src→dest only when dest does not exist yet. Returns true if copied. */
function seed(src, dest) {
  if (existsSync(dest) || !existsSync(src)) return false;
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  return true;
}

/** Recursively copy a directory, never overwriting existing destination files. */
function copyTreeNoOverwrite(srcDir, destDir) {
  if (!existsSync(srcDir)) return 0;
  let copied = 0;
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    const src = join(srcDir, entry);
    const dest = join(destDir, entry);
    if (statSync(src).isDirectory()) {
      copied += copyTreeNoOverwrite(src, dest);
    } else if (!existsSync(dest)) {
      copyFileSync(src, dest);
      copied += 1;
    }
  }
  return copied;
}

/**
 * Create/repair a user root. Returns the root path.
 * @param {string} userId
 * @param {object} [opts] - { from?: string } migrate an existing user layer in.
 */
export function scaffoldUser(userId, opts = {}) {
  const root = userRootFor(userId);
  for (const dir of SKELETON_DIRS) mkdirSync(join(root, dir), { recursive: true });

  // Migration first (so seeds below don't shadow real data).
  if (opts.from) {
    const from = opts.from;
    for (const f of ['cv.md', 'portals.yml', 'voice-dna.md', 'article-digest.md']) {
      seed(join(from, f), join(root, f));
    }
    for (const f of ['profile.yml', 'cv-facts.json', 'plugins.yml', 'benchmarks.yml']) {
      seed(join(from, 'config', f), join(root, 'config', f));
    }
    for (const d of ['data', 'reports', 'output', 'jds', 'interview-prep']) {
      copyTreeNoOverwrite(join(from, d), join(root, d));
    }
  }

  // Seeds from repo examples (only where still missing). Portals prefer the
  // Family Edition US/CA seed; the upstream example is the fallback.
  seed(join(REPO_ROOT, 'config', 'profile.example.yml'), join(root, 'config', 'profile.yml'));
  seed(join(REPO_ROOT, 'config', 'cv-facts.example.json'), join(root, 'config', 'cv-facts.json'));
  seed(join(REPO_ROOT, 'templates', 'portals.family.yml'), join(root, 'portals.yml'))
    || seed(join(REPO_ROOT, 'templates', 'portals.example.yml'), join(root, 'portals.yml'));

  if (!existsSync(join(root, 'cv.md'))) {
    writeFileSync(join(root, 'cv.md'), [
      '# Your CV',
      '',
      '> Placeholder created by scaffold-user.mjs. Replace with your real CV in',
      '> markdown — see examples/cv-example.md in the repo for the expected shape.',
      '',
    ].join('\n'));
  }
  return root;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const userId = args[0];
  const fromIdx = args.indexOf('--from');
  const from = fromIdx !== -1 ? args[fromIdx + 1] : undefined;
  if (!userId) {
    console.error('Usage: node scaffold-user.mjs <userId> [--from <existing-user-layer-dir>]');
    process.exit(2);
  }
  try {
    const root = scaffoldUser(userId, { from });
    console.log(`✅ User root ready: ${root}${from ? ` (migrated from ${from})` : ''}`);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}
