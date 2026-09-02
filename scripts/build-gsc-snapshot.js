// Pull Search Console into a local snapshot (npm run seo:gsc).
//
// scripts/lib/seo-audit.js proves a page is well-formed; it cannot tell you
// whether the page earns anything. This is the other half of that loop — what
// the ~850 generated pages actually did in search — and everything in
// scripts/seo-report.js reads it rather than hitting the API, so the report is
// instant, works offline, and gives the same answer twice in a row.
//
// The snapshot is gitignored and point-in-time, the same posture as
// chatbot/data/*.json: it is personal analytics that changes daily, and
// committing it would put a churning 5 MB blob in front of every diff.
// Re-run it before a reporting session.
//
//   npm run seo:gsc            # pull the last 90 days
//   npm run seo:gsc -- --check # verify auth and list visible properties
//   npm run seo:gsc -- --days 28

const path = require('path');
const fs = require('fs');
const { GscError, listSites, resolveSite, searchAnalytics } = require('./lib/gsc');

// Keep in sync with SITE in scripts/postbuild-web.js — the report joins these
// rows against the paths that file generates.
const SITE_HOST = 'playrecreate.com';
const OUT = path.join(__dirname, 'gsc-cache.json');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

const ymd = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
};

async function main() {
  if (has('check')) {
    const sites = await listSites();
    if (!sites.length) {
      console.log('The key authenticated, but it can see no properties.');
      console.log('Add its client_email in Search Console → Settings → Users and permissions.');
      return;
    }
    console.log(`✓ authenticated — ${sites.length} propert${sites.length === 1 ? 'y' : 'ies'} visible:`);
    for (const s of sites) console.log(`    ${s.siteUrl}  (${s.permissionLevel})`);
    console.log(`✓ resolved site: ${await resolveSite(SITE_HOST)}`);
    return;
  }

  const days = Number(arg('days', 90));
  if (!Number.isFinite(days) || days < 1 || days > 480) {
    console.error('✗ --days must be between 1 and 480 (GSC keeps 16 months)');
    process.exit(1);
  }
  const site = await resolveSite(SITE_HOST);
  // GSC finalises data a couple of days behind; asking for today just returns a
  // partial tail that reads as a traffic drop.
  const end = daysAgo(2);
  const start = daysAgo(2 + days - 1);
  const range = { start: ymd(start), end: ymd(end), days };
  console.log(`… ${site}: ${range.start} → ${range.end} (${days} days)`);

  const q = (dimensions) =>
    searchAnalytics(site, { startDate: range.start, endDate: range.end, dimensions });

  const [pages, queries, pageQueries] = [await q(['page']), await q(['query']), await q(['page', 'query'])];

  // Compact rows: this file is read by machine, is gitignored, and a page×query
  // table gets long. Objects per row would triple it for no benefit.
  const row = (r, n) => [...r.keys.slice(0, n), r.clicks, r.impressions, Number(r.position.toFixed(1))];
  const totals = pages.reduce(
    (t, r) => ({ clicks: t.clicks + r.clicks, impressions: t.impressions + r.impressions }),
    { clicks: 0, impressions: 0 }
  );

  const snapshot = {
    fetchedAt: new Date().toISOString(),
    site,
    range,
    totals: {
      ...totals,
      ctr: totals.impressions ? totals.clicks / totals.impressions : 0,
    },
    // [path, clicks, impressions, position] — the path is stored site-relative
    // so it joins straight onto what postbuild-web.js generates.
    pages: pages.map((r) => row({ ...r, keys: [relPath(r.keys[0])] }, 1)),
    queries: queries.map((r) => row(r, 1)),
    pageQueries: pageQueries.map((r) => row({ ...r, keys: [relPath(r.keys[0]), r.keys[1]] }, 2)),
  };

  fs.writeFileSync(OUT, JSON.stringify(snapshot) + '\n');
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`✓ ${path.relative(process.cwd(), OUT)} (${kb} KB)`);
  console.log(
    `✓ ${snapshot.pages.length} pages, ${snapshot.queries.length} queries, ${snapshot.pageQueries.length} page×query rows`
  );
  console.log(
    `✓ ${totals.clicks.toLocaleString()} clicks / ${totals.impressions.toLocaleString()} impressions ` +
      `(${(snapshot.totals.ctr * 100).toFixed(1)}% CTR)`
  );
  console.log('\nNext: npm run seo:report');
}

// GSC reports absolute URLs; the rest of the toolchain speaks in paths.
function relPath(url) {
  try {
    const u = new URL(url);
    return u.pathname.length > 1 ? u.pathname.replace(/\/$/, '') : '/';
  } catch {
    return url;
  }
}

main().catch((e) => {
  if (e instanceof GscError) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
  throw e;
});
