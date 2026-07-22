// tests/ats-match.test.mjs — deterministic ATS match-score tests (no network, no LLM).
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nATS match score — ats-match.mjs');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'ats-match.mjs')).href);
  const { extractJdKeywords, scoreCv, termPresent, checkHtmlFormat } = mod;

  const JD = `Senior Data Engineer

We are hiring a Senior Data Engineer to build our analytics platform.

Requirements:
- 5+ years with Python and SQL (must have)
- Expert in Apache Spark and Airflow orchestration
- Required: AWS experience (S3, Lambda, Redshift)
- Proficient with Kubernetes and Docker deployments

Nice to have:
- Snowflake and dbt exposure
- Terraform for infrastructure

You will design data pipelines, own the data warehouse, and mentor engineers.
Python is our daily driver; Python services power every data pipeline here.
`;

  // --- extraction ---------------------------------------------------------
  const keywords = extractJdKeywords(JD);
  const terms = keywords.map((k) => k.term);
  if (['python', 'sql', 'spark', 'airflow', 'aws', 'kubernetes', 'docker'].every((t) => terms.includes(t)))
    pass('extractJdKeywords finds the core skills from the JD');
  else fail(`extractJdKeywords terms = ${JSON.stringify(terms)}`);
  const python = keywords.find((k) => k.term === 'python');
  if (python && python.mustHave === true)
    pass('requirements-line skills are flagged mustHave (python)');
  else fail(`python keyword = ${JSON.stringify(python)}`);
  const snowflake = keywords.find((k) => k.term === 'snowflake');
  if (snowflake && snowflake.mustHave === false)
    pass('nice-to-have skills are not flagged mustHave (snowflake)');
  else fail(`snowflake keyword = ${JSON.stringify(snowflake)}`);
  if (!terms.includes('experience') && !terms.includes('years') && !terms.includes('team'))
    pass('boilerplate words are stopworded out');
  else fail(`boilerplate leaked into terms: ${JSON.stringify(terms)}`);

  // --- scoring ------------------------------------------------------------
  const weakCv = `# Jane Doe\n\n## Experience\n- Analyst using Excel and Tableau for reporting dashboards.\n- Some Python scripting for data cleanup.\n`;
  const strongCv = `# Jane Doe\n\n## Experience\n- Built data pipelines with Python, SQL, Apache Spark and Airflow on AWS (S3, Lambda, Redshift).\n- Deployed with Docker on Kubernetes; managed Snowflake warehouse and dbt models; Terraform IaC.\n`;
  const weak = scoreCv(keywords, weakCv);
  const strong = scoreCv(keywords, strongCv);
  if (strong.score > weak.score)
    pass(`stronger CV scores higher (${weak.score}% → ${strong.score}%)`);
  else fail(`weak=${weak.score} strong=${strong.score}`);
  if (weak.missingMustHave.includes('sql') || weak.missingMustHave.includes('aws'))
    pass('weak CV reports missing must-haves');
  else fail(`weak.missingMustHave = ${JSON.stringify(weak.missingMustHave)}`);
  if (strong.missingMustHave.length === 0)
    pass('strong CV has no missing must-haves');
  else fail(`strong.missingMustHave = ${JSON.stringify(strong.missingMustHave)}`);
  const empty = scoreCv([], strongCv);
  if (empty.score === 0) pass('empty keyword list scores 0 (no divide-by-zero)');
  else fail(`empty keywords score = ${empty.score}`);

  // --- term matching edge cases -------------------------------------------
  if (termPresent('c++', 'expert in c++ and java') && !termPresent('c++', 'expert in c and java'))
    pass('termPresent handles c++ without regex breakage');
  else fail('termPresent c++ edge case failed');
  if (termPresent('machine learning', 'applied machine learning at scale'))
    pass('termPresent matches multi-word terms');
  else fail('termPresent multi-word failed');
  if (!termPresent('java', 'javascript developer'))
    pass('termPresent does not match java inside javascript');
  else fail('termPresent substring leak: java in javascript');
  const sentenceEnd = scoreCv(
    [{ term: 'python', weight: 5, mustHave: true }, { term: 'node.js', weight: 3, mustHave: false }],
    'Analyst with some Python. Built services in Node.js.',
  );
  if (sentenceEnd.score === 100)
    pass('sentence-ending periods do not break matching (Python. / Node.js.)');
  else fail(`sentence-end score = ${sentenceEnd.score} (${JSON.stringify(sentenceEnd.missing)})`);

  // --- HTML handling ------------------------------------------------------
  const html = '<html><body><h1>Jane</h1><p>Python, SQL, Spark, Airflow, AWS, Kubernetes, Docker, Snowflake, dbt, Terraform, Redshift, Lambda, S3 — data pipelines and data warehouse ownership.</p></body></html>';
  const fromHtml = scoreCv(keywords, html);
  if (fromHtml.score >= strong.score - 10)
    pass('HTML input is tag-stripped before scoring');
  else fail(`html score = ${fromHtml.score} vs strong ${strong.score}`);
  const issues = checkHtmlFormat('<table><tr><td><img src="x.png"></td></tr></table>');
  if (issues.some((i) => i.includes('<table>')) && issues.some((i) => i.includes('images')))
    pass('checkHtmlFormat flags tables and images');
  else fail(`format issues = ${JSON.stringify(issues)}`);
  if (checkHtmlFormat('<h1>Name</h1><p>clean single column</p>').length === 0)
    pass('checkHtmlFormat passes clean single-column HTML');
  else fail(`clean HTML flagged: ${JSON.stringify(checkHtmlFormat('<h1>Name</h1><p>clean</p>'))}`);
} catch (err) {
  fail(`ats-match test crashed: ${err.message}`);
}
