#!/usr/bin/env node
//
// Is the NYC cache feeder still alive?
//
// The feeder (scripts/refresh-nyc-local.sh) runs on a Mac outside CI, twice a
// day, because nycgovparks.org answers GitHub's runner IPs with HTTP 405 and
// this machine's egress is not blocked. Nothing on that machine watches it, and
// nothing can: the failure mode that matters most is "the laptop was off", and a
// watcher living there dies with the thing it is watching. So the feeder reports
// its own liveness into the repo and this runs in CI, which does not share a
// failure domain with it.
//
// WHY THIS IS NOT THE STALE GATE. reportStale() already fails a build when a
// cache passes its budget, and that is a DATA check: it asks whether what we are
// shipping is too old, and it cannot fire until 48h have gone by. This asks
// whether the JOB is running, which is knowable much sooner and is the question
// you actually want answered. On 2026-09-15 a conflicted rebase left the feeder's
// clone mid-rebase; five consecutive runs each scraped for ten minutes and died,
// `launchctl print` reported "last exit status = 1" the whole time, and the first
// thing anybody saw was two red crons two and a half days later.
//
// THE THRESHOLD IS DELIBERATELY LOOSE. The feeder is scheduled twice daily
// precisely because these scrapes fail on transient timeouts and the schedule has
// to absorb that (see the plist). Alerting on any single failure would produce an
// alarm that is routinely wrong, which is an alarm nobody reads. 26h spans three
// scheduled runs, so this fires on the third consecutive failure — still well
// inside the 48h budget the data gate would eventually catch, but roughly a day
// earlier and naming the job rather than the symptom.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'nyc-feeder-status.json');
const REL = 'scripts/nyc-feeder-status.json';
const MAX_HOURS = Number(process.env.FEEDER_MAX_HOURS || 26);

// GitHub renders these as annotations on the run; they are plain lines elsewhere.
const isCI = !!process.env.GITHUB_ACTIONS;
const err = (msg) => console.log(isCI ? `::error::${msg}` : `✗ ${msg}`);

let status;
try {
  status = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (e) {
  err(`${REL} is missing or unreadable (${e.message}) — the feeder has never reported. Check that scripts/refresh-nyc-local.sh is installed and its LaunchAgent is loaded: launchctl print gui/$UID/com.recreate.nyc-refresh`);
  process.exit(1);
}

const hoursSince = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (Date.now() - t) / 3.6e6 : null;
};

const sinceSuccess = status.lastSuccessAt ? hoursSince(status.lastSuccessAt) : null;
const sinceRun = status.lastRunAt ? hoursSince(status.lastRunAt) : null;
// Bare duration, so call sites can add "ago" only where it reads correctly —
// "no successful run in 60.0h" and "it last ran 2.0h ago" want different shapes.
const dur = (n) => (n === null ? 'never' : `${n.toFixed(1)}h`);
const ago = (n) => (n === null ? 'never' : `${n.toFixed(1)}h ago`);

console.log(`last successful run: ${ago(sinceSuccess)} (${status.lastSuccessAt || 'never'})`);
console.log(`last run at all:     ${ago(sinceRun)} (${status.lastRunAt || 'never'})`);
console.log(`last run outcome:    ${status.lastRunOk ? 'ok' : `FAILED at "${status.lastRunStage || 'unknown'}"`}`);
if (status.sourcesFailed) console.log(`sources that did not refresh: ${status.sourcesFailed}`);

if (sinceSuccess !== null && sinceSuccess <= MAX_HOURS) {
  console.log(`\n✓ feeder alive — succeeded within ${MAX_HOURS}h`);
  process.exit(0);
}

// Separate the two diagnoses, because they send you to different places. A job
// that is running and failing has a bug or a dead upstream and its log says
// which; a job that is not running at all is a laptop, a LaunchAgent or a
// keychain problem and the log will be silent.
if (sinceRun !== null && sinceRun <= MAX_HOURS) {
  err(
    `NYC feeder is RUNNING BUT FAILING: no successful run in ${dur(sinceSuccess)} ` +
      `(limit ${MAX_HOURS}h), though it last ran ${ago(sinceRun)} and failed at ` +
      `"${status.lastRunStage || 'unknown'}"${status.sourcesFailed ? ` (sources: ${status.sourcesFailed})` : ''}. ` +
      `The NYC caches will pass their 48h budget and take the refresh workflows red next. ` +
      `Read ~/Library/Logs/recreate-nyc-refresh.log on the feeder machine.`
  );
} else {
  err(
    `NYC feeder has NOT RUN in ${dur(sinceRun)} (limit ${MAX_HOURS}h; last success ${ago(sinceSuccess)}). ` +
      `Its LaunchAgent fires at 09:15 and 21:15 local, so this means the machine was off or asleep ` +
      `through both, or the agent is unloaded. Check: launchctl print gui/$UID/com.recreate.nyc-refresh`
  );
}
process.exit(1);
