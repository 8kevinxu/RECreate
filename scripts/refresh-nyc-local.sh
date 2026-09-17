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
# Scheduled TWICE daily (09:15 / 21:15) by
# ~/Library/LaunchAgents/com.recreate.nyc-refresh.plist. The tightest staleness
# budget is 48h (NYC classes, NYC permits), and the permit window is a rolling 7
# days of ABSOLUTE dates, so it expires rather than merely ageing. Daily looks
# like it fits that budget but leaves no slack: it tolerates exactly one failed
# run, and these scrapes fail routinely on transient timeouts, so two bad days
# in a row take CI red. At 12h apart three consecutive failures still fit.
# launchd re-fires a missed StartCalendarInterval once on wake, and will not
# start a second instance while one is still running, so no lockfile is needed.

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

# Clear any rebase/merge an earlier run left half-finished. Neither reset --hard
# nor clean -fd clears one: they rewrite the index and worktree but leave
# .git/rebase-merge standing, so git refuses every later rebase with "there is
# already a rebase-merge directory". That is how one conflict on 2026-09-15
# became five dead runs and a cache that aged out of its 48h budget — the job
# kept scraping for ten minutes and kept dying on the same line. A run must cost
# at most itself, so recovery happens here rather than waiting for a human.
git rebase --abort 2>/dev/null || true
git merge  --abort 2>/dev/null || true

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

# All six NYC builds, EACH RUN SEPARATELY AND EVERY ONE OF THEM RUN. They used
# to be a single `npm run build:data:nyc`, which is an `&&` chain — so the first
# source to exit non-zero short-circuited the five behind it AND skipped the
# commit entirely. That is fatal here rather than merely wasteful, because
# reportStale() exits 1 while still shipping perfectly usable data: on 2026-09-04
# outdoor and indoor both scraped LIVE and were thrown away because the
# reservations cache had aged out. Two runs like that in a row is all a 48h
# budget can absorb, which is exactly how the caches got stuck at 09-02 with CI
# red from 09-04 on. The weekly workflow already runs each NYC source as its own
# step for this same reason; the feeder never got the same treatment.
#
# Each build still self-gates internally: a short or failed scrape keeps its own
# last-good data, so a partial upstream outage degrades instead of publishing
# junk. What changed is that one source's bad day no longer suppresses the rest.
failed=""
for b in build:nyc build:nyc-indoor build:nyc-reservations \
         build:nyc-directory build:nyc-pools build:nyc-classes; do
  npm run "$b" || failed="$failed $b"
done

if [ -n "$failed" ]; then
  echo "-- did NOT refresh:$failed — committing whatever else did"
fi

# The repo's own sanity gate: every file parses, i18n stays at parity, and the
# generated modules load with non-trivial entry counts. Committing a gutted
# scrape is worse than committing nothing. Unlike a single source failing, this
# one DOES abort the commit — it runs over the merged result, so it cannot say
# which source poisoned it and there is nothing safe to keep.
if ! npm run check; then
  echo "FAIL: npm run check — refusing to commit this build."
  exit 1
fi

# Explicit paths: this job has no business committing anything else. Held in one
# place because publishing below replays exactly this set onto a moved origin.
OWNED=(data/cities/nyc 'scripts/cities/*.json')
git add "${OWNED[@]}"
if git diff --cached --quiet; then
  echo "No NYC changes."
  [ -n "$failed" ] && exit 1
  exit 0
fi

git -c user.name="recreate-nyc-refresh" \
    -c user.email="8kevinxu@users.noreply.github.com" \
    commit -q -m "chore(data): refresh NYC sources from local egress

Scraped from a machine nycgovparks.org does not 405. Keeps the caches
inside their staleness budgets so CI's fallback stays green."

# Another job may have pushed while we scraped (~10 min), so a rejected push is
# routine. What is NOT routine — and what the old `pull --rebase` here assumed —
# is that the conflict would be rare: refresh-classes.yml regenerates
# data/cities/nyc/classes.js and the scripts/cities/*.json caches from the same
# feed we do, every 6h. Two independent regenerations of one generated file
# differ in content by definition, so that rebase conflicted on schedule.
#
# So don't merge generated files: replay ours on top of whatever landed. We
# scraped from a working egress; CI, still 405'd, wrote its files from a cache
# fallback, so ours is strictly the fresher of the two and simply wins. Only the
# paths this job owns are replayed — everything else keeps origin's version, so
# a concurrent SF refresh is never reverted.
pushed=""
for attempt in 1 2 3; do
  if git push --quiet origin "$BRANCH"; then pushed=1; break; fi
  echo "push rejected (attempt $attempt) — replaying our files onto origin/$BRANCH"
  ours=$(git rev-parse HEAD)
  git fetch --quiet origin           || { echo "FAIL: git fetch during replay"; exit 1; }
  git reset --hard --quiet "origin/$BRANCH" || { echo "FAIL: git reset during replay"; exit 1; }
  git checkout --quiet "$ours" -- "${OWNED[@]}" || { echo "FAIL: replay checkout"; exit 1; }
  git add "${OWNED[@]}"
  if git diff --cached --quiet; then
    echo "OK: origin already carries this data — nothing to push."
    pushed=1
    break
  fi
  git -c user.name="recreate-nyc-refresh" \
      -c user.email="8kevinxu@users.noreply.github.com" \
      commit -q -m "chore(data): refresh NYC sources from local egress

Scraped from a machine nycgovparks.org does not 405. Keeps the caches
inside their staleness budgets so CI's fallback stays green."
done
[ -n "$pushed" ] || { echo "FAIL: push still rejected after 3 attempts"; exit 1; }
echo "OK: pushed $(git rev-parse --short HEAD)"

# Report a partial failure only now that the good sources are safely pushed —
# the same posture as the workflow's `if: !cancelled()` steps. The run still goes
# red, so the stale gate stays loud; it just no longer costs the sources that
# were fine.
if [ -n "$failed" ]; then
  echo "FAIL: some sources did not refresh:$failed"
  exit 1
fi
