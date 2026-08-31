#!/bin/bash
#
# Refresh the NYC data from this machine and push it.
#
# WHY THIS EXISTS: nycgovparks.org's WAF answers GitHub Actions runner IPs with
# HTTP 405 (by request origin — identical code and User-Agent gets 200 from a
# residential IP), so CI can never scrape NYC live. It falls back to cache, and
# once that cache passes its budget reportStale() fails the run. This machine's
# egress is not blocked, so it scrapes and pushes the refreshed caches. CI then
# checks out a fresh cache, still 405s, still falls back — but finds fetchedAt
# recent, stays quiet, and the workflow goes green.
#
# So this is a CACHE FEEDER, not a replacement for the workflows, and it fixes
# nothing about the 405 itself. If it stops running, nothing here alerts you —
# the stale gate in CI does, by going red within 48h. That is the monitor.
#
# Scheduled daily by ~/Library/LaunchAgents/com.recreate.nyc-refresh.plist.
# Daily is the slowest cadence that works: the tightest staleness budget is 48h
# (NYC classes, NYC permits) and the permit window is a rolling 7 days of
# ABSOLUTE dates, so it expires rather than merely ageing. Once a day leaves
# room to miss one run. launchd re-fires a missed StartCalendarInterval once on
# wake, and will not start a second instance while one is still running, so no
# lockfile is needed here.

set -uo pipefail

REPO="/Users/kevin/code/RECreate"
BRANCH="main"

# launchd hands an agent a minimal PATH with no node in it. fnm's `which node`
# path is per-shell (fnm_multishells/<pid>_<ts>) and will NOT exist here — use
# the stable `default` alias, which fnm repoints when you change versions.
export PATH="$HOME/.local/share/fnm/aliases/default/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Optional: lets the build translate new class titles to zh/es. Without it they
# stay English and the build still succeeds. Put `export ANTHROPIC_API_KEY=...`
# in this file if you want them filled in at scrape time rather than waiting for
# a CI run to do it.
[ -f "$HOME/.config/recreate/refresh.env" ] && . "$HOME/.config/recreate/refresh.env"

echo "=== $(date '+%Y-%m-%d %H:%M:%S %Z') — NYC refresh ==="
cd "$REPO" || { echo "FAIL: no repo at $REPO"; exit 1; }

command -v node >/dev/null || { echo "FAIL: node not on PATH ($PATH)"; exit 1; }

# Never run over work in progress. The build rewrites tracked data files, and the
# rebase and commit below would tangle with anything half-finished. Untracked
# files (design/, flyers/, scratch dirs) are ignored — the `git add` below names
# explicit paths, so they can never be swept in. Skipping is the safe outcome: if
# the tree stays dirty long enough for the cache to age out, CI goes red and says
# so, which is exactly the signal we want.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "SKIP: working tree has uncommitted changes."
  exit 0
fi

branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "$BRANCH" ]; then
  echo "SKIP: on '$branch', not '$BRANCH'."
  exit 0
fi

# The refresh crons commit to main several times a day, so land on top of them
# rather than racing them at push time.
git pull --rebase --quiet || { echo "FAIL: git pull"; exit 1; }

# Only reinstall when the lockfile actually moved; a daily npm ci is minutes of
# work for nothing.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "-- npm ci (lockfile changed)"
  npm ci --silent || { echo "FAIL: npm ci"; exit 1; }
fi

# All six NYC builds. Each self-gates: a short or failed scrape keeps last-good
# data, so a partial upstream outage degrades instead of publishing junk.
if ! npm run build:data:nyc; then
  echo "FAIL: build:data:nyc — nothing committed, cache left as it was."
  exit 1
fi

# The repo's own sanity gate: every file parses, i18n stays at parity, and the
# generated modules load with non-trivial entry counts. Committing a gutted
# scrape is worse than committing nothing.
if ! npm run check; then
  echo "FAIL: npm run check — refusing to commit this build."
  exit 1
fi

# Explicit paths: this job has no business committing anything else.
git add data/cities/nyc scripts/cities/*.json
if git diff --cached --quiet; then
  echo "No NYC changes."
  exit 0
fi

git commit -q -m "chore(data): refresh NYC sources from local egress

Scraped from a machine nycgovparks.org does not 405. Keeps the caches
inside their staleness budgets so CI's fallback stays green."
git pull --rebase --quiet || { echo "FAIL: git pull before push"; exit 1; }
git push --quiet origin "$BRANCH" || { echo "FAIL: git push"; exit 1; }
echo "OK: pushed $(git rev-parse --short HEAD)"
