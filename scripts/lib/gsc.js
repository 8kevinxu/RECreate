// Google Search Console read access.
//
// GSC is the only source of truth for what the ~850 generated landing pages
// actually do: which of them are indexed, what people typed to reach them, and
// which queries a page already owns. Everything in scripts/lib/seo-audit.js
// proves a page is well-formed; none of it can tell you whether the page was
// worth publishing. That answer only comes back from here.
//
// No new dependency: the service-account flow is a signed JWT traded for an
// access token, and node's crypto signs RS256 directly. Adding googleapis to
// pull three JSON endpoints would be ~50 MB for a POST.
//
// SETUP (once):
//   1. In Google Cloud, create a service account and download its JSON key.
//      Enable the "Google Search Console API" on that project.
//   2. In Search Console → Settings → Users and permissions, add the service
//      account's client_email as a user (Full or Restricted — both can read).
//   3. Point GSC_SERVICE_ACCOUNT_KEY at the JSON file (or paste the JSON in).
//   4. `npm run seo:gsc -- --check` verifies auth and lists the properties the
//      key can see.
// The key is a credential: keep it out of the repo. It is not an EXPO_PUBLIC_
// var and must never reach a client bundle — it is used by these scripts only.

const crypto = require('crypto');
const fs = require('fs');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/webmasters/v3';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
// The API caps a single response at 25k rows and pages with startRow.
const PAGE_SIZE = 25000;

class GscError extends Error {}

// The key may be a path or the JSON itself — a path is what a laptop has, and
// inline JSON is what a CI secret can hold without a file.
function credentials() {
  const raw = (process.env.GSC_SERVICE_ACCOUNT_KEY || '').trim();
  if (!raw) {
    throw new GscError(
      'GSC_SERVICE_ACCOUNT_KEY is not set — point it at a service-account JSON key file ' +
        '(see the setup steps at the top of scripts/lib/gsc.js).'
    );
  }
  let text = raw;
  if (!text.startsWith('{')) {
    try {
      text = fs.readFileSync(raw.replace(/^~/, process.env.HOME || '~'), 'utf8');
    } catch (e) {
      throw new GscError(`GSC_SERVICE_ACCOUNT_KEY looks like a path but could not be read: ${e.message}`);
    }
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new GscError(`GSC_SERVICE_ACCOUNT_KEY is not valid JSON: ${e.message}`);
  }
  if (!json.client_email || !json.private_key) {
    throw new GscError('the service-account key has no client_email/private_key — is it an OAuth client key by mistake?');
  }
  return json;
}

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let cachedToken = null; // { token, expiresAt }

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60_000) return cachedToken.token;
  const key = credentials();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })
  );
  const signature = b64url(crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), key.private_key));
  const assertion = `${header}.${claims}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const body = await res.text();
  if (!res.ok) {
    // The two failures worth naming: a key whose API is switched off, and a
    // clock far enough out that the assertion is already expired.
    throw new GscError(
      `token request failed (HTTP ${res.status}): ${body.slice(0, 300)}` +
        (/invalid_grant/.test(body) ? '\n  → is the Search Console API enabled, and is this machine\'s clock right?' : '')
    );
  }
  const json = JSON.parse(body);
  cachedToken = { token: json.access_token, expiresAt: Date.now() + (json.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

async function api(path, { method = 'GET', body } = {}) {
  const token = await accessToken();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    const hint =
      res.status === 403
        ? "\n  → 403 usually means the service account is not a user on this property. Add its client_email in Search Console → Settings → Users and permissions."
        : res.status === 404
          ? '\n  → 404 usually means the site URL does not match the property exactly. A domain property is "sc-domain:example.com"; a URL-prefix property keeps its trailing slash.'
          : '';
    throw new GscError(`GSC ${method} ${path} failed (HTTP ${res.status}): ${text.slice(0, 300)}${hint}`);
  }
  return text ? JSON.parse(text) : {};
}

const listSites = () => api('/sites').then((r) => r.siteEntry || []);

// Resolve which property to read. An explicit GSC_SITE_URL wins; otherwise ask
// the API which properties this key can see and match on host, preferring the
// domain property (it aggregates http/https and every subdomain, so it is the
// one whose numbers match what the site actually earns).
async function resolveSite(siteHost) {
  const explicit = (process.env.GSC_SITE_URL || '').trim();
  if (explicit) return explicit;
  const sites = await listSites();
  if (!sites.length) {
    throw new GscError('this service account can see no Search Console properties — has it been added as a user on the property?');
  }
  const match = sites
    .map((s) => s.siteUrl)
    .filter((u) => u === `sc-domain:${siteHost}` || u.replace(/^https?:\/\//, '').replace(/\/$/, '') === siteHost)
    .sort((a, b) => (a.startsWith('sc-domain:') ? -1 : 1) - (b.startsWith('sc-domain:') ? -1 : 1));
  if (!match.length) {
    throw new GscError(
      `no Search Console property matches ${siteHost}. This key can see: ${sites.map((s) => s.siteUrl).join(', ')}. ` +
        'Set GSC_SITE_URL to the one you want.'
    );
  }
  return match[0];
}

// Search Analytics, paged to exhaustion. GSC returns at most 25k rows per
// request and simply stops — a caller that does not page silently analyses a
// truncated slice of its own traffic and cannot tell.
async function searchAnalytics(siteUrl, { startDate, endDate, dimensions, type = 'web', dataState = 'final', rowLimit = PAGE_SIZE }) {
  const path = `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const rows = [];
  for (let startRow = 0; ; startRow += rowLimit) {
    const page = await api(path, {
      method: 'POST',
      body: { startDate, endDate, dimensions, type, dataState, rowLimit, startRow },
    });
    const got = page.rows || [];
    rows.push(...got);
    if (got.length < rowLimit) break;
  }
  return rows;
}

module.exports = { GscError, accessToken, listSites, resolveSite, searchAnalytics, PAGE_SIZE };
