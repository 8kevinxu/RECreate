// Client for the assistant service in `chatbot/` — the only part of the app that
// knows it exists.
//
// Gated on EXPO_PUBLIC_ASSISTANT_URL. Unset (the default, and what production
// ships with) means `enabled` is false and the Assistant segment never renders,
// so this file costs nothing until you point it at a running service:
//
//     EXPO_PUBLIC_ASSISTANT_URL=http://localhost:8000   # simulator
//     EXPO_PUBLIC_ASSISTANT_URL=http://192.168.1.20:8000  # physical device (LAN IP)
//
// Same env-gated shape as lib/supabase.js: the feature degrades to absent rather
// than to broken.
//
// No API key lives here. The app talks to this service; the service talks to a
// model with a key that stays server-side. That's the whole reason the service
// exists rather than calling a model provider from the phone.

const BASE = (process.env.EXPO_PUBLIC_ASSISTANT_URL || '').replace(/\/+$/, '');

export const enabled = !!BASE;

// Generous on purpose. A local 3B–8B model takes 20–45s for a question that
// needs a tool call: one model turn to choose the tool, another to phrase the
// result. A hosted model is a couple of seconds. Timing out at the usual 10s
// would fail every local request.
const TIMEOUT_MS = 90000;

class AssistantError extends Error {
  constructor(message, { retryable = true, detail = '' } = {}) {
    super(message);
    this.name = 'AssistantError';
    this.retryable = retryable;
    this.detail = detail;
  }
}

async function post(path, body, timeoutMs = TIMEOUT_MS) {
  // React Native has no fetch timeout, so abort manually or a dead service
  // leaves the UI spinning forever.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new AssistantError('timeout');
    }
    // Wrong host, service not started, phone on another network.
    throw new AssistantError('unreachable', { detail: String(err.message || err) });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.json())?.detail || '';
    } catch {
      // Non-JSON error body (a proxy, say) — the status alone is enough.
    }
    if (response.status === 503) {
      // The service is up but can't answer: model backend down, missing key,
      // snapshots not generated. Its message says how to fix it, so it's worth
      // surfacing verbatim while developing.
      throw new AssistantError('unavailable', { detail });
    }
    if (response.status === 422) {
      throw new AssistantError('rejected', { retryable: false, detail });
    }
    throw new AssistantError('failed', { detail: detail || `HTTP ${response.status}` });
  }

  return response.json();
}

// Ask a question. `history` is the conversation so far as
// [{ role: 'user' | 'assistant', content }] — the service is stateless, so the
// whole thing goes up each turn and the conversation lives here in the client.
//
// `state` is what the app knows and the model must never guess: the active city
// and, if the user has shared it, their coordinates. Without them the answer
// silently loses "near me" and could describe the wrong city entirely.
export async function ask(history, { city, location, debug = false } = {}) {
  if (!enabled) throw new AssistantError('disabled', { retryable: false });

  const body = {
    // The service caps history at 30; trim here so a long chat degrades by
    // forgetting its oldest turns rather than being rejected outright.
    messages: history.slice(-20).map(({ role, content }) => ({ role, content })),
    state: {
      ...(city && { city }),
      ...(location?.latitude != null && {
        lat: location.latitude,
        lng: location.longitude,
      }),
    },
    debug,
  };

  const data = await post('/chat', body);
  return {
    reply: String(data.reply || '').trim(),
    toolsUsed: data.tools_used || [],
    model: data.model || '',
    provider: data.provider || '',
    ...(debug && { steps: data.steps, usage: data.usage }),
  };
}

// Is the service actually able to answer? Used to show a real diagnosis instead
// of a generic failure on first use. Never throws.
export async function health(timeoutMs = 4000) {
  if (!enabled) return { reachable: false, reason: 'disabled' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE}/health`, { signal: controller.signal });
    if (!response.ok) return { reachable: false, reason: `HTTP ${response.status}` };
    const body = await response.json();
    return {
      reachable: true,
      status: body.status, // 'ok' | 'degraded'
      model: body.config?.model || '',
      provider: body.config?.provider || '',
      courts: body.data?.courts ?? 0,
      generatedAt: body.data?.generatedAt || '',
    };
  } catch (err) {
    return { reachable: false, reason: String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

export { AssistantError, BASE as ASSISTANT_URL };
