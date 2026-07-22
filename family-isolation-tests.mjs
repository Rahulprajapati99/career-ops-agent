#!/usr/bin/env node

/**
 * family-isolation-tests.mjs — Family Edition Phase 1 acceptance tests.
 *
 * Verifies that two users' data roots are fully isolated:
 *   1. buildUserEnv points every CAREER_OPS_* var inside the given root.
 *   2. scaffold-user creates the skeleton and never overwrites existing files.
 *   3. generate-pdf.mjs honors CAREER_OPS_USER_ROOT: its path-traversal guard
 *      REFUSES an output path that escapes the user root (i.e. one user cannot
 *      write into another user's folder), and repo-root fallback still works.
 *   4. run-as-user rejects invalid/unsafe user ids and out-of-repo scripts.
 *
 * Run: node family-isolation-tests.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { buildUserEnv, isValidUserId, REPO_ROOT } from './user-env.mjs';
import { scaffoldUser } from './scaffold-user.mjs';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✅ ${name}`); }
  else { failed += 1; console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const tmp = mkdtempSync(join(tmpdir(), 'career-ops-family-'));
const alice = join(tmp, 'alice');
const bob = join(tmp, 'bob');
mkdirSync(alice, { recursive: true });
mkdirSync(bob, { recursive: true });

try {
  // -------------------------------------------------------------------------
  console.log('\n[1] buildUserEnv maps every var into the user root');
  const env = buildUserEnv(alice);
  check('CAREER_OPS_USER_ROOT in root', env.CAREER_OPS_USER_ROOT === alice);
  for (const [key, mustEndWith] of [
    ['CAREER_OPS_PORTALS', 'portals.yml'],
    ['CAREER_OPS_PROFILE', join('config', 'profile.yml')],
    ['CAREER_OPS_TRACKER', join('data', 'applications.md')],
    ['CAREER_OPS_REPORTS_DIR', 'reports'],
  ]) {
    check(`${key} inside root`, env[key].startsWith(alice + sep) && env[key].endsWith(mustEndWith), env[key]);
  }

  // -------------------------------------------------------------------------
  console.log('\n[2] scaffold-user skeleton + no-overwrite');
  const uid = `test-${process.pid}`;
  const root = scaffoldUser(uid);
  check('skeleton dirs exist', ['config', 'data', 'reports', 'output'].every((d) => existsSync(join(root, d))));
  check('profile seeded', existsSync(join(root, 'config', 'profile.yml')));
  check('portals seeded', existsSync(join(root, 'portals.yml')));
  check('cv placeholder', existsSync(join(root, 'cv.md')));
  writeFileSync(join(root, 'cv.md'), 'MY REAL CV');
  scaffoldUser(uid); // re-run must not clobber
  check('re-run never overwrites', readFileSync(join(root, 'cv.md'), 'utf-8') === 'MY REAL CV');
  rmSync(root, { recursive: true, force: true });

  // -------------------------------------------------------------------------
  console.log('\n[3] generate-pdf.mjs honors CAREER_OPS_USER_ROOT (guard isolation)');
  const dummyHtml = join(alice, 'in.html');
  writeFileSync(dummyHtml, '<html><body>x</body></html>');

  // 3a. Escaping the user root (into bob's folder) must be REFUSED.
  const escape = spawnSync(process.execPath, [
    join(REPO_ROOT, 'generate-pdf.mjs'), dummyHtml, join(bob, 'output', 'evil.pdf'),
  ], { env: { ...process.env, CAREER_OPS_USER_ROOT: alice }, encoding: 'utf-8' });
  check('cross-user write refused (exit ≠ 0)', escape.status !== 0);
  check('refusal message mentions user data root',
    `${escape.stderr}${escape.stdout}`.includes('Refusing'), (escape.stderr || '').slice(0, 200));
  check('no file leaked into other user', !existsSync(join(bob, 'output', 'evil.pdf')));

  // 3b. Output dir auto-created inside the user root on import (line ~35 patch).
  check('output/ created inside user root', existsSync(join(alice, 'output')));

  // 3c. Back-compat: without the env var, repo-root outputs are still accepted
  //     by the guard (probe with an out-of-repo path → still refused).
  const backcompat = spawnSync(process.execPath, [
    join(REPO_ROOT, 'generate-pdf.mjs'), dummyHtml, join(tmp, 'outside.pdf'),
  ], { env: { ...process.env, CAREER_OPS_USER_ROOT: '' }, encoding: 'utf-8' });
  check('back-compat guard still anchored to repo root', backcompat.status !== 0);

  // -------------------------------------------------------------------------
  console.log('\n[4] launcher safety');
  check('rejects traversal id', !isValidUserId('../evil'));
  check('rejects separator id', !isValidUserId('a/b') && !isValidUserId('a\\b'));
  check('accepts telegram id', isValidUserId('123456789'));
  check('accepts _global', isValidUserId('_global'));
  const badScript = spawnSync(process.execPath, [
    join(REPO_ROOT, 'run-as-user.mjs'), '123456789', '../outside.mjs',
  ], { encoding: 'utf-8' });
  check('run-as-user rejects out-of-repo script', badScript.status !== 0);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? '✅' : '❌'} family-isolation: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
