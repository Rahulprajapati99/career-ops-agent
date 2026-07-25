/**
 * lib/profile-fields.mjs — read/write a user's own contact fields in
 * config/profile.yml (the `candidate:` block).
 *
 * Why this exists: cv-import only fills these when it can find them in the
 * resume, so a member whose CV omits (say) a LinkedIn URL keeps whatever was
 * there — in the worst case a leftover scaffold placeholder. Those fields are
 * copied verbatim into every tailored CV and cover letter, so a wrong value is
 * visible to employers. Before this, fixing one meant an admin hand-editing YAML
 * on the VM; now the owner of the data can correct it from the bot.
 *
 * Text edits, not a yaml.dump round-trip: profile.yml is heavily commented and
 * those comments are the documentation a user reads. (Same reasoning as
 * set-key.mjs's writeIntegrationKey and india-toggle.mjs.)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';

/**
 * The contact fields a user may set for themselves, with how each is validated.
 * Deliberately a closed list: `candidate:` also holds things like `photo` that
 * are not free text, and an open field name would let a typo create a key
 * nothing reads.
 */
export const FIELDS = {
  full_name: { label: 'Full name', kind: 'text', max: 80 },
  email: { label: 'Email', kind: 'email', max: 120 },
  phone: { label: 'Phone', kind: 'phone', max: 40 },
  location: { label: 'Location', kind: 'text', max: 80 },
  linkedin: { label: 'LinkedIn', kind: 'url', max: 200, host: /(^|\.)linkedin\.com$/i },
  github: { label: 'GitHub', kind: 'url', max: 200, host: /(^|\.)github\.com$/i },
  portfolio_url: { label: 'Portfolio', kind: 'url', max: 200 },
};

/** Aliases people actually type. */
const ALIASES = {
  name: 'full_name', fullname: 'full_name',
  portfolio: 'portfolio_url', website: 'portfolio_url', site: 'portfolio_url',
  linkedin_url: 'linkedin', li: 'linkedin',
  github_url: 'github', gh: 'github',
  mail: 'email', tel: 'phone', mobile: 'phone', city: 'location',
};

/** Resolve a user-typed field name to a canonical key, or null. */
export function resolveField(name) {
  const k = String(name || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (FIELDS[k]) return k;
  return ALIASES[k] || null;
}

/**
 * Validate and normalize a value for a field.
 *
 * Rejects anything a shell could reinterpret and anything with a newline (which
 * would break the single-line YAML scalar these are written as). URLs are
 * normalized to an absolute https:// form so they are clickable wherever they
 * are rendered, and host-checked when the field names a specific site — a
 * "LinkedIn" that points somewhere else is a mistake worth catching here rather
 * than printing on a CV.
 *
 * @param {string} field  Canonical field key.
 * @param {string} raw    User input.
 * @returns {{ok: true, value: string} | {ok: false, reason: string}}
 */
export function normalizeValue(field, raw) {
  const spec = FIELDS[field];
  if (!spec) return { ok: false, reason: `unknown field "${field}"` };

  let v = String(raw ?? '')
    .replace(/^[<"'`\s]+/, '')
    .replace(/[>"'`\s]+$/, '')
    .trim();
  if (!v) return { ok: false, reason: 'value is empty' };
  if (/[\r\n]/.test(v)) return { ok: false, reason: 'value must be a single line' };
  if (v.length > spec.max) return { ok: false, reason: `value is longer than ${spec.max} characters` };
  // Keep free text boring, since it lands in YAML and shell-adjacent tooling.
  // NOT applied to URLs: "&" is ordinary in a query string, and a pasted profile
  // link routinely carries tracking params. URLs are made safe instead by being
  // reparsed and rebuilt from origin+path below, which drops the query entirely.
  if (spec.kind !== 'url' && /[`$;|&\\]/.test(v)) {
    return { ok: false, reason: 'value contains characters that are not allowed' };
  }

  if (spec.kind === 'email') {
    if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(v)) return { ok: false, reason: 'that does not look like an email address' };
    return { ok: true, value: v };
  }

  if (spec.kind === 'phone') {
    if (!/^[+()\d\s.-]{7,}$/.test(v)) return { ok: false, reason: 'that does not look like a phone number' };
    return { ok: true, value: v };
  }

  if (spec.kind === 'url') {
    const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`;
    let u;
    try { u = new URL(withScheme); } catch { return { ok: false, reason: 'that does not look like a URL' }; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'only http(s) links are allowed' };
    if (spec.host && !spec.host.test(u.hostname)) {
      return { ok: false, reason: `a ${spec.label} link should be on ${String(spec.host).replace(/[^a-z.]/gi, '') || 'that site'}` };
    }
    // Rebuild from origin + path ONLY. This drops tracking noise (?trk=, #top)
    // and is also the safety step: whatever was pasted, the stored value can only
    // be a scheme, host and path, so nothing shell- or YAML-hostile survives.
    const rebuilt = `${u.origin}${u.pathname}`.replace(/\/$/, '');
    if (/[`$;|&\\\s]/.test(rebuilt)) return { ok: false, reason: 'that URL contains characters that are not allowed' };
    return { ok: true, value: rebuilt };
  }

  return { ok: true, value: v };
}

/** Current candidate fields, as plain strings. */
export function readCandidate(profilePath) {
  try {
    if (!existsSync(profilePath)) return {};
    const cand = (yaml.load(readFileSync(profilePath, 'utf-8')) || {}).candidate || {};
    const out = {};
    for (const k of Object.keys(FIELDS)) if (cand[k] != null && cand[k] !== '') out[k] = String(cand[k]);
    return out;
  } catch { return {}; }
}

/**
 * Write one `candidate.<field>` value, preserving the file's comments.
 *
 * Scoped to the `candidate:` block on purpose: several top-level blocks can
 * carry a key of the same name (integrations, targets), and a whole-file regex
 * would edit the wrong one.
 *
 * @param {string} profilePath
 * @param {string} field  Canonical field key.
 * @param {string} value  Already normalized.
 * @returns {{changed: boolean, previous: string|null}}
 */
export function writeCandidateField(profilePath, field, value) {
  if (!FIELDS[field]) throw new Error(`unknown field "${field}"`);
  if (!existsSync(profilePath)) throw new Error(`no profile.yml at ${profilePath}`);

  const previous = readCandidate(profilePath)[field] ?? null;
  if (previous === value) return { changed: false, previous };

  const lines = readFileSync(profilePath, 'utf-8').split('\n');
  const start = lines.findIndex((l) => /^candidate:\s*$/.test(l));
  if (start === -1) throw new Error('profile.yml has no `candidate:` block');

  // The block runs until the next top-level key.
  let end = start + 1;
  while (end < lines.length && !/^[A-Za-z_][\w-]*:/.test(lines[end])) end += 1;

  const quoted = `"${value.replace(/"/g, '')}"`;
  const at = lines.slice(start + 1, end).findIndex((l) => new RegExp(`^\\s*${field}:`).test(l));
  if (at === -1) {
    lines.splice(start + 1, 0, `  ${field}: ${quoted}`);
  } else {
    const idx = start + 1 + at;
    // Keep any trailing "# comment" — those notes tell the user what a field does.
    const comment = lines[idx].match(/(\s+#.*)$/)?.[1] || '';
    const indent = lines[idx].match(/^(\s*)/)[1] || '  ';
    lines[idx] = `${indent}${field}: ${quoted}${comment}`;
  }

  const next = lines.join('\n');
  // Never leave a profile the rest of the system cannot read.
  try { yaml.load(next); } catch (err) {
    throw new Error(`edit would produce invalid YAML — aborted (${err.message})`);
  }
  writeFileSync(profilePath, next);
  return { changed: true, previous };
}
