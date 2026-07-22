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

Append the Family Edition variables to the existing `.env` (keep your current
`TELEGRAM_BOT_TOKEN` and `GEMINI_API_KEY` lines as they are):

```bash
cat >> .env <<'EOF'
# — Family Edition —
TELEGRAM_ALLOWED_IDS=8772217091          # add the other 3 ids comma-separated later
ADZUNA_APP_KEY=REDACTED_ADZUNA_APP_KEY_ROTATED
# ADZUNA_APP_ID=<get from https://developer.adzuna.com dashboard>
EOF
```

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

## 5. Daily global scan (cron)

```bash
crontab -e
# add (07:00 VM-local time, adjust to taste):
0 7 * * * cd $HOME/career-ops-agent && /usr/bin/node run-as-user.mjs _global scan.mjs >> $HOME/career-ops-scan.log 2>&1
```

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
