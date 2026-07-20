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

module.exports = { fetchT };
