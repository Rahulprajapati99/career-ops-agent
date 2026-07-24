# Family Edition — Oracle VM Deployment (existing VM upgrade)

This runbook upgrades an **existing** Oracle Cloud VM that already runs
career-ops + the Telegram bot to the multi-user Family Edition. It is
idempotent — safe to re-run.

## 0. What changes on the VM

- The repo moves to the `family-edition` branch (multi-user).
- The bot now REQUIRES `TELEGRAM_ALLOWED_IDS` in `.env` (it refuses to start
  without it) and serves each user inside `users/<telegram_id>/`.
- Your existing single-user data (cv.md, config/, data/, reports/, output/)
  gets **migrated into `users/<your_id>/`** — one command, nothing deleted.
- A daily cron scans the shared `_global` pool.

## 1. Update the code

```bash
cd ~/career-ops-agent            # wherever the repo lives on the VM
git fetch origin
git checkout family-edition
git pull origin family-edition
npm install                      # picks up node-telegram-bot-api + lockfile
```

## 2. Environment (.env)

⚠️ **The VM's existing `TELEGRAM_BOT_TOKEN` and `GEMINI_API_KEY` are both
STALE (2026-07-23)** — the bot token was revoked via BotFather and the Gemini
key was rotated. **Replace both lines** with the current values from the PC's
`career-ops-agent/.env` before starting the bot; the old values will fail.

Then append the Family Edition variables to `.env`:

```bash
cat >> .env <<'EOF'
# — Family Edition —
TELEGRAM_ALLOWED_IDS=8772217091          # add the other 3 ids comma-separated later
ADZUNA_APP_KEY=<copy from the PC's career-ops-agent/.env — never commit the value>
# ADZUNA_APP_ID=<get from https://developer.adzuna.com dashboard>
EOF
```

Also: **stop the bot on the PC before `pm2 start` on the VM** — Telegram
allows only one polling consumer per token; two pollers = 409 conflicts.

## 3. Migrate your existing single-user data

Your current data sits at the repo root (old layout). Move it into your user
root (copies, never overwrites; re-runnable):

```bash
node scaffold-user.mjs 8772217091 --from .
node scaffold-user.mjs _global            # shared job pool (if not present)
cp templates/portals.family.yml users/_global/portals.yml   # first time only
```

Sanity check: `node run-as-user.mjs 8772217091 doctor.mjs` should report your
real cv.md/profile, not placeholders.

## 4. Restart the bot

However the bot is currently supervised (pm2 shown; systemd equivalent below):

```bash
pm2 restart telegram-bot || pm2 start telegram-bot.mjs --name telegram-bot
pm2 save
```

systemd alternative: `sudo systemctl restart career-ops-bot`.

Log check: the bot must print
`🤖 Career-Ops Family Bot online — serving 1 allowlisted user(s).`
If it exits complaining about `TELEGRAM_ALLOWED_IDS`, step 2 didn't land.

## 5. Daily scan + digest (cron)

One job does both: it rescans each user's own portals, ranks the results against
their profile, and pushes them a Telegram digest of what is new, live, and
actually relevant.

```bash
crontab -e
# add (07:00 VM-local time, adjust to taste):
0 7 * * * /bin/bash -lc 'cd $HOME/career-ops-agent && node daily-digest.mjs --scan' >> $HOME/career-ops-digest.log 2>&1
```

`/bin/bash -lc` is load-bearing — cron's bare environment has no PATH to node
and does not load `.env`.

Preview without sending anything:

```bash
node daily-digest.mjs --dry-run
```

Useful flags: `--user <id>` (one person), `--top 5` (jobs per digest),
`--min-score 35` (relevance floor). Users control delivery themselves from
Telegram with `/digest off` and `/digest on`; `/digest` alone shows their
current matches on demand.

## 5b. Web dashboard (Phase 7)

The dashboard is upstream's single-user Next app, made multi-user by a gateway
that runs **one dashboard process per signed-in user**, each pinned to that
user's own data root. Isolation is enforced by the OS — separate processes,
separate roots — rather than by every query remembering to filter.

```bash
cd $HOME/career-ops-agent/web && npm install && npm run build && cd ..
node web-gateway.mjs --check     # verifies env + that the build exists
pm2 start web-gateway.mjs --name career-ops-web && pm2 save
```

Add to `.env`:

```
TELEGRAM_BOT_USERNAME=YourBotName                    # no @; renders the login button
CAREER_OPS_PUBLIC_URL=https://your-tunnel-hostname   # required behind Cloudflare Tunnel
# CAREER_OPS_SESSION_SECRET=<random hex>             # optional; derived from the bot token if unset
```

Expose it with a free Cloudflare Tunnel (no open inbound ports, free TLS):

```bash
cloudflared tunnel --url http://localhost:8080
```

Then set `CAREER_OPS_PUBLIC_URL` to the hostname it prints, restart the gateway,
and point the Telegram login widget at that domain via **@BotFather →
/setdomain**. Without that step Telegram refuses to render the login button.

Sign-in flow: `/login` shows the Telegram widget → Telegram signs the payload →
the gateway verifies the HMAC with the bot token, checks the allowlist, and sets
a signed session cookie. The allowlist is re-checked on **every** request, so
removing an id from `TELEGRAM_ALLOWED_IDS` locks that person out immediately
rather than whenever their cookie happens to expire.

Each user's first page load spawns their dashboard (a few seconds); after that
it stays warm. Budget roughly 200–300 MB of RAM per active user.

## 5c. India (Phase 8)

Off by default — Canada plus US-remote only. Per user, one command:

```
/india on      # in Telegram
/india off
```

or on the VM: `node run-as-user.mjs <id> india-toggle.mjs --on`. It flips all
three things that must agree (the geo-policy opt-in, the Adzuna India portal
entry, and the `location_filter` block); `--off` restores `portals.yml`
byte-for-byte.

## 6. Smoke test from Telegram

1. `/start` — should greet you; if it asks for a resume, your migration in
   step 3 didn't find cv.md (re-run with the right `--from` path).
2. Send any job URL — evaluate → tailor buttons → PDF arrives.
3. `/cover` — cover-letter PDF arrives (needs `GEMINI_API_KEY`).
4. `/applykit` — CV + cover + prefill notes arrive as documents.
5. `/whoami` — confirms your id and `users/8772217091/` root.

## 7. Adding the other 3 family members later

1. Each person messages the bot; it replies with their id (or they use
   `/whoami` once added).
2. Append the id to `TELEGRAM_ALLOWED_IDS` (comma-separated) in `.env`.
3. `pm2 restart telegram-bot`.
4. Their user root auto-scaffolds on first `/start`; onboarding walks them
   through uploading their resume. No other setup.

## Notes

- `users/` is gitignored (PII). Back it up separately — e.g. a private repo
  or a nightly `tar` to Object Storage; it is NOT covered by `git pull`.
- `update-system.mjs` never touches `users/` or the fork-local scripts
  (registered in USER_PATHS), so upstream updates stay safe.
- Adzuna entries in the `_global` portals stay in a loud-error state until
  `ADZUNA_APP_ID` is added; every other source works without it.
