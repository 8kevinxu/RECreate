// Read the Search Console snapshot against the pages we actually publish
// (npm run seo:report). This is the measurement half of the loop:
// scripts/lib/seo-audit.js proves a page is well-formed, this says whether it
// earned anything, and neither can answer the other's question.
//
//   npm run seo:report                      # coverage + the four worklists
//   npm run seo:report -- "pickleball nyc"  # ownership check for one query
//   npm run seo:report -- --page /nyc/handball
//
// Every number comes from the snapshot in scripts/gsc-cache.json — run
// `npm run seo:gsc` first, and again whenever you want fresher data. Nothing
// here calls the API, so the same command twice gives the same answer.
//
// The verdicts are heuristics over evidence that is printed alongside them, not
// findings. GSC is the source of truth; this is a reading of it.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// GSC_SNAPSHOT points somewhere else — a second range kept side by side, or a
// fixture when exercising this file's own output.
const SNAP = process.env.GSC_SNAPSHOT || path.join(__dirname, 'gsc-cache.json');

// A page below this in a 90-day window has effectively no signal — treating it
// as a ranking datum reads noise as a trend.
const MIN_IMPRESSIONS = 30;
// Positions 5-20: on page one or just off it, where a title, a description or
// a few internal links move the needle. Below 20 the problem is rarely the tag.
const STRIKING = [4.5, 20];
// A page at position <= 10 earning well under this is being out-written in the
// SERP, not out-ranked — the fixable case.
const LOW_CTR = 0.02;

const num = (n) => n.toLocaleString('en-US');
const pct = (n) => `${(n * 100).toFixed(1)}%`;
const pad = (s, n) => String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s).padEnd(n);

function loadSnapshot() {
  if (!fs.existsSync(SNAP)) {
    console.error('✗ no snapshot at scripts/gsc-cache.json — run `npm run seo:gsc` first.');
    console.error('  (first time? `npm run seo:gsc -- --check` verifies the credentials.)');
    process.exit(1);
  }
  const snap = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
  const ageDays = (Date.now() - Date.parse(snap.fetchedAt)) / 864e5;
  if (ageDays > 7) {
    console.warn(`⚠ snapshot is ${ageDays.toFixed(0)} days old (${snap.range.start} → ${snap.range.end}) — re-run \`npm run seo:gsc\`\n`);
  }
  return snap;
}

// The generated page set, from the one file that knows it.
function loadPages() {
  const tmp = path.join(os.tmpdir(), `recreate-seo-pages-${process.pid}.json`);
  const r = spawnSync(process.execPath, [path.join(__dirname, 'postbuild-web.js')], {
    env: { ...process.env, SEO_PAGES: tmp },
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error('✗ could not enumerate the generated pages:');
    console.error(r.stderr || r.stdout);
    process.exit(1);
  }
  const pages = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  fs.unlinkSync(tmp);
  return pages;
}

// --- one query: does anything already own this intent? ------------------------
//
// The mistake this exists to prevent is generating a page that competes with
// one already ranking. So: who gets impressions for this today, and are they
// splitting them?
function queryReport(snap, pages, term) {
  const needle = term.toLowerCase();
  const rows = snap.pageQueries.filter(([, q]) => q.toLowerCase().includes(needle));
  const exact = snap.queries.filter(([q]) => q.toLowerCase() === needle);
  const related = snap.queries.filter(([q]) => q.toLowerCase().includes(needle));

  console.log(`\n"${term}" — ${snap.range.start} → ${snap.range.end}\n`);
  if (!related.length) {
    console.log('  No impressions for anything containing this term.\n');
    console.log('  VERDICT: CREATE — nothing on the site is being shown for it, so there is');
    console.log('  no page to cannibalise. Confirm the intent is real before building: zero');
    console.log('  impressions can also mean nobody searches this.\n');
    return;
  }

  const totals = related.reduce((t, [, c, i]) => ({ clicks: t.clicks + c, impressions: t.impressions + i }), { clicks: 0, impressions: 0 });
  console.log(`  ${related.length} matching quer${related.length === 1 ? 'y' : 'ies'}, ${num(totals.impressions)} impressions, ${num(totals.clicks)} clicks`);
  if (exact.length) {
    const [, c, i, p] = exact[0];
    console.log(`  exact match "${term}": ${num(i)} impressions, ${num(c)} clicks, avg position ${p}`);
  }

  // Which pages are shown for it, biggest first.
  const byPage = new Map();
  for (const [pagePath, , clicks, impressions, position] of rows) {
    const cur = byPage.get(pagePath) || { clicks: 0, impressions: 0, position: 0, n: 0 };
    byPage.set(pagePath, {
      clicks: cur.clicks + clicks,
      impressions: cur.impressions + impressions,
      position: cur.position + position * impressions,
      n: cur.n + impressions,
    });
  }
  const owners = [...byPage.entries()].map(([p, v]) => ({
    path: p, clicks: v.clicks, impressions: v.impressions, position: v.n ? v.position / v.n : 0,
  })).sort((a, b) => b.impressions - a.impressions);

  console.log('\n  Pages shown for it:');
  for (const o of owners.slice(0, 8)) {
    console.log(`    ${pad(o.path, 46)} ${String(num(o.impressions)).padStart(7)} impr  ${String(num(o.clicks)).padStart(5)} clk  pos ${o.position.toFixed(1)}`);
  }

  const top = owners[0];
  const second = owners[1];
  const split = second && second.impressions > top.impressions * 0.35;
  console.log('');
  if (split) {
    console.log(`  VERDICT: REJECT (fix the split first) — ${owners.length} pages share this intent,`);
    console.log(`  the top two within ${pct(second.impressions / top.impressions)} of each other. A third page makes it worse.`);
    console.log('  Decide which page owns it, and point the others at it or differentiate them.');
  } else if (top.position > STRIKING[1]) {
    console.log(`  VERDICT: IMPROVE EXISTING — ${top.path} already owns it but sits at position ${top.position.toFixed(1)}.`);
    console.log('  A new page starts from zero and competes with this one; strengthen it instead.');
  } else {
    console.log(`  VERDICT: IMPROVE EXISTING — ${top.path} owns it at position ${top.position.toFixed(1)}.`);
    console.log('  Only create something new if the intent is genuinely different from that page\'s.');
  }
  console.log('');
}

// --- one page: what is it actually ranking for? -------------------------------
function pageReport(snap, pages, target) {
  const page = pages.find((p) => p.path === target);
  const row = snap.pages.find(([p]) => p === target);
  console.log(`\n${target}${page ? `\n  ${page.title}` : '  (not a generated page)'}\n`);
  if (!row) {
    console.log('  No impressions in this window.');
    console.log(page ? '  It is published but has never been shown — check indexing in GSC.\n' : '\n');
    return;
  }
  const [, clicks, impressions, position] = row;
  console.log(`  ${num(impressions)} impressions, ${num(clicks)} clicks, ${pct(clicks / impressions)} CTR, avg position ${position}\n`);
  const qs = snap.pageQueries.filter(([p]) => p === target).sort((a, b) => b[3] - a[3]).slice(0, 15);
  console.log('  Top queries:');
  for (const [, q, c, i, pos] of qs) {
    console.log(`    ${pad(q, 46)} ${String(num(i)).padStart(7)} impr  ${String(num(c)).padStart(5)} clk  pos ${pos}`);
  }
  console.log('');
}

// --- the whole site ------------------------------------------------------------
function coverage(snap, pages) {
  const byPath = new Map(snap.pages.map(([p, c, i, pos]) => [p, { clicks: c, impressions: i, position: pos }]));
  // An alias serves the same page; credit its numbers to the canonical path.
  const aliasOf = new Map();
  for (const p of pages) for (const a of p.aliases) aliasOf.set(a, p.path);
  for (const [alias, canonical] of aliasOf) {
    const from = byPath.get(alias);
    if (!from) continue;
    const to = byPath.get(canonical) || { clicks: 0, impressions: 0, position: 0 };
    byPath.set(canonical, {
      clicks: to.clicks + from.clicks,
      impressions: to.impressions + from.impressions,
      position: to.position || from.position,
    });
  }

  const t = snap.totals;
  console.log(`\nplayrecreate.com — ${snap.range.start} → ${snap.range.end} (${snap.range.days} days)`);
  console.log(`  ${num(t.clicks)} clicks · ${num(t.impressions)} impressions · ${pct(t.ctr)} CTR`);
  console.log(`  ${pages.length} generated pages, snapshot taken ${snap.fetchedAt.slice(0, 10)}\n`);

  // 1. Published but never shown.
  const dark = pages.filter((p) => !byPath.has(p.path));
  const byKind = dark.reduce((m, p) => ((m[p.kind] = (m[p.kind] || 0) + 1), m), {});
  console.log(`— Published but never shown: ${dark.length}/${pages.length} pages (${pct(dark.length / pages.length)})`);
  for (const [kind, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    const total = pages.filter((p) => p.kind === kind).length;
    console.log(`    ${pad(kind, 14)} ${String(n).padStart(4)} of ${String(total).padStart(4)}`);
  }
  console.log('    These are indexing or thin-content questions, not ranking ones. A whole');
  console.log('    kind going dark is a template problem; a long tail of court pages is');
  console.log('    what earnsPage() is already trying to bound.\n');

  // 2. Striking distance: on or near page one, worth a push.
  const striking = [...byPath.entries()]
    .filter(([, v]) => v.impressions >= MIN_IMPRESSIONS && v.position >= STRIKING[0] && v.position <= STRIKING[1])
    .sort((a, b) => b[1].impressions - a[1].impressions)
    .slice(0, 12);
  console.log(`— Striking distance (position ${STRIKING[0]}–${STRIKING[1]}, ≥${MIN_IMPRESSIONS} impressions): ${striking.length} shown`);
  for (const [p, v] of striking) {
    console.log(`    ${pad(p, 46)} ${String(num(v.impressions)).padStart(7)} impr  pos ${v.position.toFixed(1)}  ${pct(v.clicks / v.impressions)} CTR`);
  }
  console.log('');

  // 3. Ranking well, being clicked badly — a title/description problem.
  const weak = [...byPath.entries()]
    .filter(([, v]) => v.impressions >= MIN_IMPRESSIONS && v.position <= 10 && v.clicks / v.impressions < LOW_CTR)
    .sort((a, b) => b[1].impressions - a[1].impressions)
    .slice(0, 12);
  console.log(`— Good position, poor CTR (pos ≤10, CTR <${pct(LOW_CTR)}): ${weak.length} shown`);
  for (const [p, v] of weak) {
    console.log(`    ${pad(p, 46)} ${String(num(v.impressions)).padStart(7)} impr  pos ${v.position.toFixed(1)}  ${pct(v.clicks / v.impressions)} CTR`);
  }
  console.log('    Being out-written in the SERP, not out-ranked: the title and description');
  console.log('    are the lever, and they are generated, so a fix here fixes a whole kind.\n');

  // 4. Cannibalization — the thing the build gate cannot see.
  //
  // seo-audit.js proves no two pages share a TITLE. It cannot prove no two
  // pages chase one INTENT; only impressions show that.
  const perQuery = new Map();
  for (const [p, q, c, i] of snap.pageQueries) {
    if (!perQuery.has(q)) perQuery.set(q, []);
    perQuery.get(q).push({ path: p, clicks: c, impressions: i });
  }
  const cannibal = [...perQuery.entries()]
    .map(([q, rows]) => {
      const sorted = rows.sort((a, b) => b.impressions - a.impressions);
      const total = sorted.reduce((n, r) => n + r.impressions, 0);
      return { q, sorted, total };
    })
    .filter((c) => c.total >= MIN_IMPRESSIONS && c.sorted.length > 1 && c.sorted[1].impressions > c.sorted[0].impressions * 0.35)
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);
  console.log(`— Split intent (2+ pages sharing one query): ${cannibal.length} shown`);
  for (const c of cannibal) {
    console.log(`    "${c.q}" — ${num(c.total)} impressions across ${c.sorted.length} pages`);
    for (const r of c.sorted.slice(0, 3)) {
      console.log(`        ${pad(r.path, 44)} ${String(num(r.impressions)).padStart(7)} impr`);
    }
  }
  console.log('    The build gate proves titles are unique; only this shows two pages');
  console.log('    chasing one intent. Pick an owner, then differentiate or consolidate.\n');

  console.log('Next: npm run seo:report -- "<query>" to check ownership before building a page.\n');
}

function main() {
  const args = process.argv.slice(2);
  const snap = loadSnapshot();
  const pages = loadPages();
  const pageIdx = args.indexOf('--page');
  if (pageIdx >= 0 && args[pageIdx + 1]) return pageReport(snap, pages, args[pageIdx + 1]);
  const term = args.filter((a) => !a.startsWith('--'))[0];
  return term ? queryReport(snap, pages, term) : coverage(snap, pages);
}

main();
