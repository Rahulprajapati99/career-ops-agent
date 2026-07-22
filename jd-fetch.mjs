#!/usr/bin/env node

/**
 * jd-fetch.mjs — Family Edition: fetch a job description by URL, API-first.
 *
 * ATS job pages (Ashby, Greenhouse, Lever) are JS-heavy SPAs that need a full
 * browser to scrape — yet all three expose public zero-auth APIs that return
 * the same JD as clean JSON. This fetcher recognizes those URLs and takes the
 * API path (fast, no Playwright, works on headless VMs); anything else falls
 * back to browser-extract.mjs.
 *
 * Usage:
 *   node jd-fetch.mjs <job-url>     # JD text on stdout; non-zero exit on failure
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeEntities } from './providers/_html-entities.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Convert JD HTML to readable plain text: block-level closers become line
 * breaks, list items become "- " bullets, then tags are stripped and entities
 * decoded. Exported for tests.
 */
export function htmlToText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/ul|\/ol)\s*\/?\s*>/gi, '\n')
      .replace(/<\s*li[^>]*>/gi, '\n- ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Recognize ATS job URLs that have a public API behind them.
 * Exported for tests.
 *
 * @param {string} url
 * @returns {{ kind: 'ashby'|'greenhouse'|'lever', org: string, id: string } | null}
 */
export function parseJobUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean);

  // Ashby: jobs.ashbyhq.com/{org}/{uuid}[/application]
  if (host === 'jobs.ashbyhq.com' && segs.length >= 2) {
    const id = segs.find((s) => UUID_RE.test(s));
    if (id) return { kind: 'ashby', org: segs[0], id };
  }

  // Greenhouse: (job-)boards(.eu).greenhouse.io/{org}/jobs/{id}  or  /{org}?gh_jid={id}
  if (/^(job-)?boards(\.eu)?\.greenhouse\.io$/.test(host) && segs.length >= 1) {
    const jobsIdx = segs.indexOf('jobs');
    if (jobsIdx > 0 && /^\d+$/.test(segs[jobsIdx + 1] || '')) {
      return { kind: 'greenhouse', org: segs[0], id: segs[jobsIdx + 1] };
    }
    const ghJid = u.searchParams.get('gh_jid');
    if (ghJid && /^\d+$/.test(ghJid)) return { kind: 'greenhouse', org: segs[0], id: ghJid };
  }

  // Lever: jobs(.eu).lever.co/{org}/{uuid}
  if (/^jobs(\.eu)?\.lever\.co$/.test(host) && segs.length >= 2 && UUID_RE.test(segs[1])) {
    return { kind: 'lever', org: segs[0], id: segs[1] };
  }

  return null;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; career-ops/1.3)', accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** API-path fetch. Returns { title, company, location, description } or null. */
export async function fetchViaApi(parsed) {
  const { kind, org, id } = parsed;

  if (kind === 'ashby') {
    const json = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}`);
    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
    const job = jobs.find((j) => j?.id === id || String(j?.jobUrl || '').includes(id));
    if (!job) return null;
    const desc = job.descriptionHtml || job.descriptionPlain || '';
    if (!desc) return null;
    return {
      title: job.title || '',
      company: job.organizationName || org,
      location: job.location || '',
      description: htmlToText(desc),
    };
  }

  if (kind === 'greenhouse') {
    const json = await fetchJson(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(org)}/jobs/${encodeURIComponent(id)}`,
    );
    if (!json?.content) return null;
    // Greenhouse returns HTML-escaped HTML — decode once, then flatten.
    return {
      title: json.title || '',
      company: json.company_name || org,
      location: json.location?.name || '',
      description: htmlToText(decodeEntities(json.content)),
    };
  }

  if (kind === 'lever') {
    const json = await fetchJson(
      `https://api.lever.co/v0/postings/${encodeURIComponent(org)}/${encodeURIComponent(id)}`,
    );
    if (!json?.text && !json?.descriptionPlain) return null;
    const parts = [json.descriptionPlain || htmlToText(json.description || '')];
    for (const list of Array.isArray(json.lists) ? json.lists : []) {
      parts.push(`${list.text || ''}\n${htmlToText(list.content || '')}`);
    }
    parts.push(json.additionalPlain || '');
    return {
      title: json.text || '',
      company: org,
      location: json.categories?.location || '',
      description: parts.filter(Boolean).join('\n\n'),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node jd-fetch.mjs <job-url>');
    process.exit(2);
  }

  const parsed = parseJobUrl(url);
  if (parsed) {
    try {
      const jd = await fetchViaApi(parsed);
      if (jd && jd.description.length > 100) {
        console.log(`Title: ${jd.title}\nCompany: ${jd.company}\nLocation: ${jd.location}\n\n${jd.description}`);
        process.exit(0);
      }
      console.error(`jd-fetch: ${parsed.kind} API had no description for this posting — trying browser extraction`);
    } catch (err) {
      console.error(`jd-fetch: ${parsed.kind} API failed (${err.message}) — trying browser extraction`);
    }
  }

  // Fallback: full browser extraction (needs Playwright browsers installed).
  try {
    const out = execFileSync(process.execPath, [join(__dirname, 'browser-extract.mjs'), url], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024 * 10,
    });
    process.stdout.write(out);
  } catch (err) {
    // Surface the browser's real failure so the bot can relay an actionable
    // cause (e.g. "Executable doesn't exist" → chromium not installed).
    const tail = String(err.stderr || err.message || '')
      .split('\n').filter(Boolean).slice(-3).join(' · ');
    console.error(`jd-fetch: browser extraction failed too — ${tail}`);
    process.exit(1);
  }
}
