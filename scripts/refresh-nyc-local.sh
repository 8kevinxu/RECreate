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
# IT WORKS IN ITS OWN CLONE, NOT YOUR CHECKOUT. The first version guarded on a
# clean working tree and skipped instead, which was the wrong shape: the build
# rewrites tracked files under data/cities/nyc and scripts/cities, and a second
# Claude session works in this repo continuously, so "dirty" is the normal state
# and the job skipped every single run without ever doing its work. Worse, two
# of that session's in-progress files (data/cities/nyc/outdoor-courts.js,
# scripts/cities/nyc-cache.json) sat inside the paths this script stages, so
# without the guard it would have committed someone's half-finished work. A
# dedicated clone removes both problems: nothing else ever touches it, so it can
# hard-reset to origin/main every run and never has to reason about local edits.
#
# Scheduled daily by ~/Library/LaunchAgents/com.recreate.nyc-refresh.plist.
# Daily is the slowest cadence that works: the tightest staleness budget is 48h
# (NYC classes, NYC permits) and the permit window is a rolling 7 days of
# ABSOLUTE dates, so it expires rather than merely ageing. launchd re-fires a
# missed StartCalendarInterval once on wake, and will not start a second
# instance while one is still running, so no lockfile is needed here.

set -uo pipefail

REPO_URL="https://github.com/8kevinxu/RECreate.git"
WORKDIR="$HOME/.local/share/recreate-nyc-refresh"
BRANCH="main"

# launchd hands an agent a minimal PATH with no node in it. fnm's `which node`
# path is per-shell (fnm_multishells/<pid>_<ts>) and will NOT exist here — use
# the stable `default` alias, which fnm repoints when you change versions.
export PATH="$HOME/.local/share/fnm/aliases/default/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Optional: lets the build translate new class titles to zh/es. Without it they
# stay English and the build still succeeds — CI has the key and fills in
# anything missed on its next run, so this is genuinely optional.
[ -f "$HOME/.config/recreate/refresh.env" ] && . "$HOME/.config/recreate/refresh.env"

echo "=== $(date '+%Y-%m-%d %H:%M:%S %Z') — NYC refresh ==="

command -v node >/dev/null || { echo "FAIL: node not on PATH ($PATH)"; exit 1; }
command -v git  >/dev/null || { echo "FAIL: git not on PATH"; exit 1; }

# This script hard-resets and cleans its checkout. Refuse to do that anywhere
# near a directory a human works in — a mistyped WORKDIR must not eat your repo.
case "$WORKDIR" in
  */.local/share/recreate-nyc-refresh) ;;
  *) echo "FAIL: WORKDIR '$WORKDIR' is not the dedicated clone path."; exit 1 ;;
esac

if [ ! -d "$WORKDIR/.git" ]; then
  echo "-- first run: cloning into $WORKDIR"
  mkdir -p "$(dirname "$WORKDIR")"
  git clone --quiet "$REPO_URL" "$WORKDIR" || { echo "FAIL: clone"; exit 1; }
fi

cd "$WORKDIR" || { echo "FAIL: cannot cd to $WORKDIR"; exit 1; }

# Start from exactly origin/main every run. Safe here in a way it would never be
# in your checkout: this clone holds nothing but the last run's regenerated data,
# which we are about to regenerate anyway. This also replaces the pull --rebase
# the old version did, which could conflict; a reset cannot.
git fetch --quiet origin || { echo "FAIL: git fetch"; exit 1; }
git checkout --quiet "$BRANCH" 2>/dev/null || git checkout --quiet -b "$BRANCH" "origin/$BRANCH"
git reset --hard --quiet "origin/$BRANCH" || { echo "FAIL: git reset"; exit 1; }
git clean -fdq   # strays from an interrupted run; node_modules is gitignored, so untouched

# Only reinstall when the lockfile actually moved; a daily npm ci is minutes of
# work for nothing.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "-- npm ci (lockfile changed or first run)"
  npm ci --silent || { echo "FAIL: npm ci"; exit 1; }
fi

# All six NYC builds. Each self-gates: a short or failed scrape keeps last-good
# data, so a partial upstream outage degrades instead of publishing junk.
if ! npm run build:data:nyc; then
  echo "FAIL: build:data:nyc — nothing committed, origin left as it was."
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

git -c user.name="recreate-nyc-refresh" \
    -c user.email="8kevinxu@users.noreply.github.com" \
    commit -q -m "chore(data): refresh NYC sources from local egress

Scraped from a machine nycgovparks.org does not 405. Keeps the caches
inside their staleness budgets so CI's fallback stays green."

# Another job may have pushed while we scraped (~10 min). Rebase onto it; this
# clone has nothing else in flight, so a conflict here is not survivable and
# should fail loudly rather than be forced past.
git pull --rebase --quiet origin "$BRANCH" || { echo "FAIL: rebase onto origin/$BRANCH"; exit 1; }
git push --quiet origin "$BRANCH" || { echo "FAIL: git push"; exit 1; }
echo "OK: pushed $(git rev-parse --short HEAD)"
