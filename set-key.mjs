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
 *   node set-key.mjs --credits         # show usage for every key on file
 *
 * Markers: KEY_SAVED · KEY_USED · KEY_LIMIT
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

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, { redirect: 'error', signal: controller.signal });
    return await res.json().catch(() => null);
  } catch { return null; } finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const fmt = (u) => (u ? `${u.used}/${u.limit ?? '?'} used this month` : 'usage unavailable');

  if (args.includes('--credits')) {
    let any = false;
    for (const [name, svc] of Object.entries(SERVICES)) {
      const key = loadIntegrationKey(PROFILE_PATH, svc.field);
      if (!key) continue;
      any = true;
      const usage = svc.usage(await fetchJson(svc.account(key)));
      console.log(`📊 ${svc.label}: ${fmt(usage)}`);
    }
    if (!any) console.log('ℹ️ No API keys on file yet. Use /setkey hunter <key> or /setkey serpapi <key>.');
    process.exit(0);
  }

  const service = args[0];
  const key = args[1];
  const svc = SERVICES[service];
  if (!svc || !key) {
    console.error('Usage: node set-key.mjs <hunter|serpapi> <key>  |  --credits');
    process.exit(2);
  }
  const usage = svc.usage(await fetchJson(svc.account(key)));
  if (!usage) {
    console.error(`❌ ${svc.label} rejected that key (could not read the account). Double-check it and retry.`);
    console.log('KEY_SAVED: no');
    process.exit(1);
  }
  writeIntegrationKey(PROFILE_PATH, svc.field, key);
  console.log(`✅ ${svc.label} key saved. ${fmt(usage)}`);
  console.log('KEY_SAVED: yes');
  console.log(`KEY_USED: ${usage.used}`);
  console.log(`KEY_LIMIT: ${usage.limit ?? ''}`);
}
