# Per-User Search Profiles (dynamic, config-driven)

Job discovery is **already per-user and fully dynamic** — there is no shared,
hard-coded query. Each user's search lives in their own
`users/<telegram_id>/portals.yml`, and the provider adapters build every API
query from it. To retarget a user, you edit that one file (or, on onboarding,
seed it from a role preset below). Nothing in code needs to change.

## How the "query builder" actually works (no database)

The system is file-based by design (upstream doctrine — files are canonical).
The pieces that make search dynamic:

| Concern | Where it lives | Per-user? |
|---|---|---|
| Role / keyword targeting | `portals.yml → title_filter.positive/negative` | ✅ |
| Aggregator query terms | `portals.yml → job_boards[].what` (e.g. Adzuna) | ✅ |
| Geography | `portals.yml → location_filter` + `geo-policy.mjs` | ✅ |
| Recency | `portals.yml → max_posting_age_days` | ✅ |
| Target companies (ATS) | `portals.yml → tracked_companies[]` | ✅ |
| Normalized output | canonical `Job` shape (`providers/_types.js`) | shared |

Each `providers/*.mjs` adapter is the "query builder": it reads the per-user
`portals.yml` entry and constructs that source's API call (e.g.
`providers/adzuna.mjs` turns `{ country, what, where, max_days_old }` into the
Adzuna REST query), then normalizes the response into the one canonical `Job`
shape every downstream step consumes. So "injecting varied parameters" = the
per-user `portals.yml`; no schema or code change required to add a new user
with a different target.

## Role presets — copy the block into a user's `portals.yml`

### Senior QA · AI/LLM Agent Dev · Test Automation  (Rahul — active)
```yaml
title_filter:
  positive: [qa, quality, "quality assurance", sdet, test, "test automation",
             automation, "ai engineer", "ai agent", "agent development",
             agentic, llm, "machine learning", "prompt engineer"]
  negative: [unpaid, volunteer, intern, internship, junior, "co-op", graduate]
job_boards:
  - { name: Adzuna US, provider: adzuna, country: us, what: "qa automation engineer" }
  - { name: Adzuna CA, provider: adzuna, country: ca, what: "qa automation engineer" }
```

### Recruitment / HR Management  (theoretical HR user)
```yaml
title_filter:
  positive: [recruiter, "talent acquisition", "hr manager", "human resources",
             "people operations", "hr business partner", hrbp, sourcer,
             "recruiting", "talent partner"]
  negative: [unpaid, volunteer, intern, internship]
job_boards:
  - { name: Adzuna US, provider: adzuna, country: us, what: "talent acquisition manager" }
  - { name: Adzuna CA, provider: adzuna, country: ca, what: "hr manager" }
```

### Senior Leadership / CTO  (theoretical tech-exec user)
```yaml
title_filter:
  positive: [cto, "chief technology", "vp engineering", "vice president",
             "head of engineering", "director of engineering", "engineering director",
             "senior director", "svp"]
  negative: [unpaid, volunteer, intern, internship, junior, associate]
job_boards:
  - { name: Adzuna US, provider: adzuna, country: us, what: "vp engineering" }
  - { name: Adzuna CA, provider: adzuna, country: ca, what: "cto" }
```

Everything else (location policy, remote-first ranking, dedup, recency) is
shared and needs no per-role change. When we want in-bot switching, a
`/setrole qa|hr|exec` command can drop the matching block into the user's
`portals.yml` — the presets above are the source of truth for that.
