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
} catch (err) {
  fail(`gemini-cover test crashed: ${err.message}`);
}
