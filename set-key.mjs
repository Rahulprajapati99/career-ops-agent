#!/usr/bin/env node

/**
 * set-key.mjs — Family Edition: save + validate a per-user integration API key
 * (Hunter.io for email verification, SerpApi for Google Jobs), and report the
 * free-tier usage so nobody blows their monthly quota.
 *
 * Validates against the service's ACCOUNT endpoint (free — consumes no search
 * credit), then writes it into config/profile.yml integrations.<field>.
 *
 * Usage:
 *   node set-key.mjs hunter  <key>     # save + validate a Hunter.io key
 *   node set-key.mjs serpapi <key>     # save + validate a SerpApi key
 *   node set-key.mjs gemini  <key>     # save + validate a Google AI Studio key
 *   node set-key.mjs --credits         # show usage for every key on file
 *
 * Markers: KEY_SAVED · KEY_USED · KEY_LIMIT · KEY_ERROR
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const USER_ROOT = process.env.CAREER_OPS_USER_ROOT
  ? resolve(process.env.CAREER_OPS_USER_ROOT)
  : process.cwd();
const PROFILE_PATH = process.env.CAREER_OPS_PROFILE || join(USER_ROOT, 'config', 'profile.yml');

/** Supported services: how to validate + where their usage counts live. */
export const SERVICES = {
  hunter: {
    label: 'Hunter.io',
    field: 'hunter_api_key',
    account: (k) => `https://api.hunter.io/v2/account?api_key=${encodeURIComponent(k)}`,
    usage: (j) => {
      const s = j?.data?.requests?.searches || j?.data?.calls;
      if (!s) return null;
      const used = Number(s.used) || 0;
      const avail = s.available != null ? Number(s.available) : null;
      return { used, limit: avail != null ? used + avail : (s.limit != null ? Number(s.limit) : null) };
    },
  },
  gemini: {
    label: 'Gemini',
    field: 'gemini_api_key',
    // models.list is free and does NOT consume generate-content quota.
    account: (k) => `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(k)}`,
    // Google exposes no remaining-quota endpoint — a non-empty model list means
    // the key is valid; usage counts are reported as unknown.
    usage: (j) => (Array.isArray(j?.models) && j.models.length ? { used: null, limit: null } : null),
  },
  serpapi: {
    label: 'SerpApi',
    field: 'serpapi_key',
    account: (k) => `https://serpapi.com/account.json?api_key=${encodeURIComponent(k)}`,
    usage: (j) => {
      if (!j || j.error) return null;
      const used = Number(j.this_month_usage) || 0;
      const limit = j.searches_per_month != null ? Number(j.searches_per_month)
        : (j.plan_searches_left != null ? used + Number(j.plan_searches_left) : null);
      return { used, limit };
    },
  },
};

/** Persist an integrations.<field> value into profile.yml (comment-preserving). Exported. */
export function writeIntegrationKey(profilePath, field, key) {
  const clean = String(key || '').replace(/"/g, '').trim();
  let text = existsSync(profilePath) ? readFileSync(profilePath, 'utf-8') : '';
  const line = `  ${field}: "${clean}"`;
  const re = new RegExp(`^\\s*${field}:.*$`, 'm');
  if (re.test(text)) text = text.replace(re, line);
  else if (/^integrations:\s*$/m.test(text)) text = text.replace(/^integrations:\s*$/m, `integrations:\n${line}`);
  else text = `${text.replace(/\s*$/, '')}\n\nintegrations:\n${line}\n`;
  writeFileSync(profilePath, text);
}

/** Read a saved key for a service from profile.yml (or its env var). Exported. */
export function loadIntegrationKey(profilePath, field) {
  if (existsSync(profilePath)) {
    try {
      const intg = (yaml.load(readFileSync(profilePath, 'utf-8')) || {}).integrations || {};
      if (intg[field] && String(intg[field]).trim()) return String(intg[field]).trim();
    } catch { /* fall through */ }
  }
  return '';
}

/**
 * GET a JSON account endpoint.
 *
 * Returns the parsed body plus the transport detail needed to explain a
 * failure. Swallowing that detail is what turned "API key not valid" into the
 * bot's misleading "network issue or bad key".
 *
 * @param {string} url
 * @returns {Promise<{json: any, status: number, error: string|null}>}
 */
async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, { redirect: 'error', signal: controller.signal });
    const json = await res.json().catch(() => null);
    return { json, status: res.status, error: null };
  } catch (e) {
    return { json: null, status: 0, error: e.name === 'AbortError' ? 'request timed out after 15s' : e.message };
  } finally { clearTimeout(timer); }
}

/** One-line reason a validation attempt failed, for humans. */
function rejectionReason({ json, status, error }) {
  if (error) return `could not reach the provider (${error})`;
  const apiMsg = json?.error?.message || json?.errors?.[0]?.details || json?.error;
  if (typeof apiMsg === 'string' && apiMsg.trim()) return `${apiMsg.trim()} (HTTP ${status})`;
  return `provider returned HTTP ${status} with no usable account data`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const fmt = (u) => {
    if (!u) return 'usage unavailable';
    if (u.used == null) return 'key valid (Google exposes no remaining-quota API)';
    return `${u.used}/${u.limit ?? '?'} used this month`;
  };

  if (args.includes('--credits')) {
    let any = false;
    for (const [name, svc] of Object.entries(SERVICES)) {
      const key = loadIntegrationKey(PROFILE_PATH, svc.field);
      if (!key) continue;
      any = true;
      const usage = svc.usage((await fetchJson(svc.account(key))).json);
      console.log(`📊 ${svc.label}: ${fmt(usage)}`);
    }
    if (!any) console.log('ℹ️ No API keys on file yet. Use /setkey hunter <key> or /setkey serpapi <key>.');
    process.exit(0);
  }

  const service = args[0];
  const key = args[1];
  const svc = SERVICES[service];
  if (!svc || !key) {
    console.error('Usage: node set-key.mjs <hunter|serpapi|gemini> <key>  |  --credits');
    process.exit(2);
  }
  const result = await fetchJson(svc.account(key));
  const usage = svc.usage(result.json);
  if (!usage) {
    const reason = rejectionReason(result);
    console.error(`❌ ${svc.label} rejected that key: ${reason}`);
    console.log('KEY_SAVED: no');
    // Machine-readable so the bot can tell the user the real cause instead of
    // guessing between "network issue" and "bad key".
    console.log(`KEY_ERROR: ${reason.replace(/\s+/g, ' ')}`);
    process.exit(1);
  }
  writeIntegrationKey(PROFILE_PATH, svc.field, key);
  console.log(`✅ ${svc.label} key saved. ${fmt(usage)}`);
  console.log('KEY_SAVED: yes');
  console.log(`KEY_USED: ${usage.used}`);
  console.log(`KEY_LIMIT: ${usage.limit ?? ''}`);
}
