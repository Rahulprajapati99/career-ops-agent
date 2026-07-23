// tests/gemini-cover.test.mjs — model-JSON parsing hardening (no network).
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nCover letter — gemini-cover.mjs');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'gemini-cover.mjs')).href);
  const { parseModelJson, LETTER_SCHEMA } = mod;

  const clean = parseModelJson('{"company":"Acme","role_title":"QA"}');
  if (clean.company === 'Acme') pass('parses a plain JSON object');
  else fail(`plain parse = ${JSON.stringify(clean)}`);

  const fenced = parseModelJson('```json\n{"company":"Acme"}\n```');
  if (fenced.company === 'Acme') pass('strips markdown code fences');
  else fail(`fenced parse = ${JSON.stringify(fenced)}`);

  const chatty = parseModelJson('Here is the letter:\n{"company":"Acme","closing":"Thanks"}\nHope this helps!');
  if (chatty.company === 'Acme' && chatty.closing === 'Thanks')
    pass('trims prose before/after the JSON object');
  else fail(`chatty parse = ${JSON.stringify(chatty)}`);

  let threw = null;
  try { parseModelJson('no json here at all'); } catch (e) { threw = e; }
  if (threw) pass('throws a clear error when no JSON object exists');
  else fail('should throw on non-JSON input');

  if (LETTER_SCHEMA?.required?.includes('company') && LETTER_SCHEMA?.properties?.achievements)
    pass('LETTER_SCHEMA pins required fields for constrained decoding');
  else fail(`schema = ${JSON.stringify(LETTER_SCHEMA?.required)}`);
  if (!LETTER_SCHEMA?.properties?.greeting)
    pass('greeting is removed from the schema (built in code, not by the model)');
  else fail('greeting should not be a model-filled field');

  // --- collapseField: kills the newline-wall / letter-dump bug ------------
  const { collapseField, looksLikeFullLetter } = mod;
  const dumped = 'Dear Hiring Team,' + '\n'.repeat(5000) + 'full letter body here';
  const collapsed = collapseField(dumped, 600);
  if ((collapsed.match(/\n/g) || []).length === 0 && collapsed.length <= 600)
    pass('collapseField strips newline walls and caps length');
  else fail(`collapseField len=${collapsed.length} newlines=${(collapsed.match(/\n/g) || []).length}`);
  if (collapseField('  multi   space\t\ttext  ', 100) === 'multi space text')
    pass('collapseField normalizes internal whitespace');
  else fail(`collapseField = ${JSON.stringify(collapseField('  multi   space\t\ttext  ', 100))}`);

  // --- looksLikeFullLetter: the quality gate ------------------------------
  if (looksLikeFullLetter('…thanks for your time.\n\nSincerely,\nRahul Prajapati'))
    pass('looksLikeFullLetter flags a signature block');
  else fail('should flag "Sincerely," signatures');
  if (looksLikeFullLetter('a'.repeat(1500))) pass('looksLikeFullLetter flags oversized fields');
  else fail('should flag > 1400 char fields');
  if (!looksLikeFullLetter('A concise, single-sentence opening about the role.'))
    pass('looksLikeFullLetter passes a clean fragment');
  else fail('clean fragment wrongly flagged');
} catch (err) {
  fail(`gemini-cover test crashed: ${err.message}`);
}
