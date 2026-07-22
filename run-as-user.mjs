#!/usr/bin/env node

/**
 * run-as-user.mjs — Family Edition launcher: run any career-ops script as a
 * specific user, with that user's data fully isolated in users/<id>/.
 *
 * The core scripts resolve user data via cwd + CAREER_OPS_* env overrides, so
 * isolation needs no core rewrites: set cwd to the user's root, point the env
 * vars into it, and exec the script from the repo root.
 *
 * Usage:
 *   node run-as-user.mjs <userId> <script.mjs> [args...]
 *
 * Examples:
 *   node run-as-user.mjs 123456789 scan.mjs
 *   node run-as-user.mjs _global   scan.mjs          # shared job pool scan
 *   node run-as-user.mjs 123456789 generate-pdf.mjs --input output/cv.html --output output/cv.pdf
 *
 * Programmatic use (Telegram bot / web dashboard):
 *   import { runAsUser } from './run-as-user.mjs';
 *   const { code } = await runAsUser('123456789', 'scan.mjs', ['--quiet']);
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, userRootFor, buildUserEnv } from './user-env.mjs';

/**
 * Resolve a script reference to an absolute path inside the repo root.
 * Rejects anything that escapes the repo (defense against injected paths).
 */
function resolveScript(script) {
  const abs = resolve(REPO_ROOT, script);
  const rel = relative(REPO_ROOT, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Script must live inside the career-ops repo: ${script}`);
  }
  if (!existsSync(abs)) {
    throw new Error(`Script not found: ${abs}`);
  }
  return abs;
}

/**
 * Spawn `node <script> [args]` with cwd + env bound to the user's data root.
 *
 * @param {string} userId  - users/<id> folder name (Telegram id, handle, or _global).
 * @param {string} script  - Script path relative to the repo root (e.g. "scan.mjs").
 * @param {string[]} args  - Arguments passed through to the script.
 * @param {object} [opts]  - { stdio } forwarded to spawn (default "inherit").
 * @returns {Promise<{code: number}>}
 */
export function runAsUser(userId, script, args = [], opts = {}) {
  const userRoot = userRootFor(userId);
  if (!existsSync(userRoot)) {
    throw new Error(
      `No data root for user "${userId}" (${userRoot}). Run: node scaffold-user.mjs ${userId}`
    );
  }
  const scriptPath = resolveScript(script);
  const env = { ...process.env, ...buildUserEnv(userRoot) };

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: userRoot,
      env,
      stdio: opts.stdio ?? 'inherit',
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => resolvePromise({ code: code ?? 1 }));
  });
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [userId, script, ...args] = process.argv.slice(2);
  if (!userId || !script) {
    console.error('Usage: node run-as-user.mjs <userId> <script.mjs> [args...]');
    process.exit(2);
  }
  try {
    const { code } = await runAsUser(userId, script, args);
    process.exit(code);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}
