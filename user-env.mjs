#!/usr/bin/env node

/**
 * user-env.mjs — Family Edition multi-user support (shared helper).
 *
 * Maps a per-user data root (users/<id>/) to the CAREER_OPS_* environment
 * variables that the core scripts already honor:
 *
 *   CAREER_OPS_USER_ROOT    → the user's root folder (generate-pdf, reply-watch,
 *                             openrouter-runner fall back to it)
 *   CAREER_OPS_PORTALS      → <root>/portals.yml            (scan.mjs)
 *   CAREER_OPS_PROFILE      → <root>/config/profile.yml     (scan.mjs, cv-templates.mjs)
 *   CAREER_OPS_TRACKER      → <root>/data/applications.md   (tracker-utils.mjs)
 *   CAREER_OPS_REPORTS_DIR  → <root>/reports                (reserve-report-num.mjs,
 *                                                            openrouter-runner.mjs)
 *
 * Everything else in the user layer is cwd-relative in the core scripts, so
 * isolation = run the script with cwd=<root> plus this env. See run-as-user.mjs.
 *
 * The special pseudo-user `_global` holds the shared job pool: a scan run as
 * `_global` against the shared base portals list produces the family-wide
 * pipeline that per-user matching later filters from.
 */

import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repo root (where the system scripts live). */
export const REPO_ROOT = __dirname;

/** Directory that holds all per-user data roots. */
export const USERS_DIR = join(REPO_ROOT, 'users');

/** Pseudo-user whose data/pipeline.md is the shared, family-wide job pool. */
export const GLOBAL_USER = '_global';

/**
 * Valid user ids: Telegram numeric ids, simple handles, or the _global
 * pseudo-user. Blocks path traversal ("../..", absolute paths, separators).
 */
export function isValidUserId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/**
 * Absolute path of a user's data root. Throws on invalid ids.
 */
export function userRootFor(userId) {
  if (!isValidUserId(userId)) {
    throw new Error(`Invalid user id "${userId}" (allowed: letters, digits, _ , -)`);
  }
  return join(USERS_DIR, userId);
}

/**
 * Build the CAREER_OPS_* env map for a user root. Merge it OVER process.env
 * (user-specific values must win over any globally exported ones):
 *   { ...process.env, ...buildUserEnv(root) }
 *
 * @param {string} userRoot - Absolute or relative path to the user's root.
 * @returns {Record<string, string>}
 */
export function buildUserEnv(userRoot) {
  const root = resolve(userRoot);
  return {
    CAREER_OPS_USER_ROOT: root,
    CAREER_OPS_PORTALS: join(root, 'portals.yml'),
    CAREER_OPS_PROFILE: join(root, 'config', 'profile.yml'),
    CAREER_OPS_TRACKER: join(root, 'data', 'applications.md'),
    CAREER_OPS_REPORTS_DIR: join(root, 'reports'),
    CAREER_OPS_ADDITIONS: join(root, 'batch', 'tracker-additions'),
  };
}
