// Shared fetch wrapper with a hard timeout. Node's global fetch has NO default
// timeout: if a server accepts the connection but then stalls — never sending a
// response, or trickling bytes forever — a bare `fetch()` hangs indefinitely. On a
// scheduled GitHub runner that means the job burns until the runner is killed
// ("the hosted runner lost communication with the server") instead of failing
// fast. Every build script's last-good-cache safety net only triggers on a thrown
// error, so a silent hang defeats it entirely. Aborting a stalled request turns it
// into a thrown error, letting that fallback do its job.
const DEFAULT_TIMEOUT_MS = 30000;

async function fetchT(url, opts = {}, ms = DEFAULT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`fetch timed out after ${ms}ms: ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Retry, but only what is actually worth retrying.
//
// A timeout or a socket error is a blip: on 2026-09-04 the permit sweep timed
// out on ONE of its ~217 requests and on 09-05 Socrata timed out on two pages,
// and each time the whole source fell back to cache. Both endpoints answered in
// under a second when checked minutes later — nothing was wrong upstream, and
// two such runs in a row is what pushed the NYC caches past their 48h budget.
//
// A 5xx/429/408 is the server asking for a moment, so those are retried too.
// Every other 4xx is a decision the server will simply make again — above all
// nycgovparks' 405, which is keyed to the CALLER'S IP, so retrying it would
// only make CI spend three times as long learning what it already knows. Those
// come straight back to the caller, which throws on !res.ok exactly as before.
const RETRY_BACKOFF_MS = [0, 2000, 6000];
const retryable = (status) => status >= 500 || status === 429 || status === 408;

async function fetchTR(url, opts = {}, ms = DEFAULT_TIMEOUT_MS, tries = RETRY_BACKOFF_MS.length) {
  let last;
  for (let i = 0; i < tries; i++) {
    if (i) {
      console.log(`    \u21bb retry ${i}/${tries - 1} in ${RETRY_BACKOFF_MS[i] / 1000}s \u2014 ${last.message}`);
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[i]));
    }
    try {
      const res = await fetchT(url, opts, ms);
      if (!retryable(res.status)) return res;
      last = new Error(`HTTP ${res.status} for ${url}`);
    } catch (e) {
      last = e; // timeout or network error — both worth another go
    }
  }
  throw last;
}

module.exports = { fetchT, fetchTR };
