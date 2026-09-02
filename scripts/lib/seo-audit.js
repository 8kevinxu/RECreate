// SEO assertions over the generated landing pages (scripts/postbuild-web.js).
//
// Everything the site's SEO depends on used to live only in CLAUDE.md prose and
// in whoever remembered it: unique titles, a canonical that resolves, no orphan
// pages, no thin stubs, a BreadcrumbList whose crumbs are real URLs. Each of
// those fails silently — the site keeps building and keeps serving while the
// ranking quietly dies, so nothing else notices when one breaks. Hence a gate.
//
// Pure: takes the page objects plus their rendered HTML and returns findings.
// Called two ways — from the real build (so a bad page fails `build:web`) and
// from `npm run check` via SEO_AUDIT=1, which builds the same pages in memory
// and needs no `expo export`.

// These bounds catch runaway strings, NOT length Google merely trims. Long
// titles and descriptions are the house style here ("Basketball in New York
// City — 618 free public basketball courts | RECreate"), the SERP truncates the
// tail, and the words still count — so failing ~80 pages for being longer than
// a snippet would be a warning wall that teaches people to ignore the gate.
// What is worth catching is a template that has come apart: an unbounded join,
// a name concatenated twice.
const TITLE_MAX = 120;
const DESC_MIN = 60;
const DESC_MAX = 320;
// The SERP shows roughly this much of a description. Two pages whose full
// descriptions differ only past this point still LOOK identical in results,
// which is the half of duplication a user (and Google's snippet dedupe) sees.
const DESC_SNIPPET = 155;
// A page under this much rendered body text is the doorway-page failure mode
// earnsPage() exists to prevent. Placed against the measured floor rather than
// far below it, for the reason the rec.us gate is: a threshold set to catch
// only total collapse never fires while the data quietly erodes. The thinnest
// indexable page today renders ~674 chars (a golf course), the median ~1,800.
const BODY_MIN_CHARS = 600;

const one = (n, s) => `${n} ${s}${n === 1 ? '' : 's'}`;

// Strip query/hash: an internal link may carry app URL state (/?sport=…&city=…)
// and still be a link to "/".
const linkPath = (href) => {
  const p = href.split('#')[0].split('?')[0];
  if (!p) return '/';
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
};

const textOf = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const mainOf = (html) => {
  const m = html.match(/<main>([\s\S]*?)<\/main>/);
  return m ? textOf(m[1]) : '';
};

const attr = (html, re) => {
  const m = html.match(re);
  return m ? m[1] : null;
};

const RE = {
  title: /<title>([\s\S]*?)<\/title>/,
  desc: /<meta name="description" content="([^"]*)"/,
  canonical: /<link rel="canonical" href="([^"]*)"/g,
  robots: /<meta name="robots" content="([^"]*)"/,
  h1: /<h1[^>]*>([\s\S]*?)<\/h1>/g,
  href: /href="(\/[^"]*)"/g,
  ld: /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
};

/**
 * @param {object}   o
 * @param {object[]} o.pages        page objects that go in the sitemap
 * @param {Map}      o.rendered     path -> rendered HTML (includes aliases + /404)
 * @param {string}   o.site         origin, e.g. https://playrecreate.com
 * @param {Set}      o.staticPaths  paths served by real files outside the generator
 * @returns {{ errors: string[], warnings: string[], stats: object }}
 */
function auditSeo({ pages, rendered, site, staticPaths = new Set() }) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  // Sitemap = the canonical, indexable set. Aliases and /404 are served but
  // deliberately absent from it.
  const sitemap = new Set(pages.map((p) => p.path));
  const aliases = new Set();
  for (const p of pages) for (const a of p.aliasPaths || []) aliases.add(a);

  // Anything a crawler can actually reach.
  const servable = new Set([...sitemap, ...aliases, ...staticPaths, '/']);

  // --- 1. one clear identity per page: unique title, unique description ------
  //
  // Two pages with one title is the cannibalization signature: Google picks one,
  // canonicalizes the other away, and the authority splits instead of stacking.
  // Aliases are excluded — they are one page at two paths, by design.
  const byTitle = new Map();
  const byDesc = new Map();
  for (const p of pages) {
    const t = (p.title || '').trim();
    const d = (p.description || '').trim();
    if (!t) err(`title: ${p.path} has no title`);
    if (!d) err(`description: ${p.path} has no description`);
    if (t) byTitle.set(t, (byTitle.get(t) || []).concat(p.path));
    if (d) byDesc.set(d, (byDesc.get(d) || []).concat(p.path));
    if (t.length > TITLE_MAX) warn(`title: ${p.path} is ${t.length} chars (> ${TITLE_MAX})`);
    if (d && (d.length < DESC_MIN || d.length > DESC_MAX))
      warn(`description: ${p.path} is ${d.length} chars (want ${DESC_MIN}-${DESC_MAX})`);
  }
  for (const [t, paths] of byTitle)
    if (paths.length > 1) err(`title: ${one(paths.length, 'page')} share "${t}" — ${paths.slice(0, 4).join(', ')}${paths.length > 4 ? ', …' : ''}`);
  for (const [d, paths] of byDesc)
    if (paths.length > 1) err(`description: ${one(paths.length, 'page')} share a description — ${paths.slice(0, 4).join(', ')}${paths.length > 4 ? ', …' : ''}`);

  // Descriptions that diverge only past the snippet fold: not a build failure,
  // but the pages present the same face in search results.
  const bySnippet = new Map();
  for (const p of pages) {
    const head = (p.description || '').trim().slice(0, DESC_SNIPPET);
    if (head) bySnippet.set(head, (bySnippet.get(head) || []).concat(p.path));
  }
  for (const [, paths] of bySnippet)
    if (paths.length > 1 && !byDesc.has(paths[0]))
      warn(`description: ${one(paths.length, 'page')} are identical for the first ${DESC_SNIPPET} chars — ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ', …' : ''}`);

  // --- 2. rendered head/body: h1, canonical, robots, thin content ------------
  const inbound = new Map(); // target path -> Set(source paths)
  const link = (to, from) => {
    if (!inbound.has(to)) inbound.set(to, new Set());
    if (to !== from) inbound.get(to).add(from);
  };

  for (const [pagePath, html] of rendered) {
    const page = pages.find((p) => p.path === pagePath);
    const isAlias = aliases.has(pagePath);
    const label = pagePath;

    // Exactly one H1. Two H1s split the page's stated topic; zero leaves the
    // primary intent unstated in the one element that is meant to carry it.
    const h1s = [...html.matchAll(RE.h1)].map((m) => textOf(m[1]));
    if (h1s.length !== 1) err(`h1: ${label} has ${h1s.length} h1 elements (want exactly 1)`);
    else if (!h1s[0]) err(`h1: ${label} has an empty h1`);

    const robots = attr(html, RE.robots);
    const canonicals = [...html.matchAll(RE.canonical)].map((m) => m[1]);
    const noindex = /noindex/.test(robots || '');

    if (noindex) {
      // A noindex page must not also claim a canonical (the two directives
      // contradict) and must stay out of the sitemap.
      if (canonicals.length) err(`canonical: ${label} is noindex but declares a canonical`);
      if (sitemap.has(pagePath)) err(`sitemap: ${label} is noindex but is listed in the sitemap`);
    } else {
      if (canonicals.length !== 1) {
        err(`canonical: ${label} declares ${canonicals.length} canonicals (want exactly 1)`);
      } else {
        const target = canonicals[0].startsWith(site) ? canonicals[0].slice(site.length) || '/' : null;
        if (!target) err(`canonical: ${label} points off-site (${canonicals[0]})`);
        else if (!sitemap.has(target))
          err(`canonical: ${label} points at ${target}, which is not in the sitemap`);
        else if (isAlias && target === pagePath)
          err(`canonical: alias ${label} is self-canonical — it should point at its primary`);
        else if (!isAlias && target !== pagePath)
          err(`canonical: ${label} points at ${target} but is itself in the sitemap (both would compete)`);
      }
      // Every indexable page is either in the sitemap or an alias of one.
      if (!sitemap.has(pagePath) && !isAlias)
        err(`sitemap: ${label} is indexable but absent from the sitemap`);
    }

    // Thin content. A noindex page (the 404) is exempt: it is not competing for
    // anything, and padding it out would be the opposite of the point.
    const bodyText = mainOf(html);
    if (!noindex && bodyText.length < BODY_MIN_CHARS)
      err(`thin: ${label} renders ${bodyText.length} chars of body text (< ${BODY_MIN_CHARS})`);

    // --- 3. internal links resolve, and feed the orphan check ---------------
    for (const m of html.matchAll(RE.href)) {
      const to = linkPath(m[1]);
      if (!servable.has(to)) err(`link: ${label} links to ${to}, which nothing serves`);
      else link(to, pagePath);
    }

    // --- 4. JSON-LD parses, and its breadcrumbs resolve ----------------------
    //
    // ~350 NYC pages once declared a BreadcrumbList whose first crumb was /nyc
    // before /nyc existed. Google drops the whole trail when an item 404s, so
    // the markup was doing nothing and nothing said so.
    for (const m of html.matchAll(RE.ld)) {
      let json;
      try {
        json = JSON.parse(m[1]);
      } catch (e) {
        err(`json-ld: ${label} has unparseable JSON-LD (${e.message})`);
        continue;
      }
      for (const block of [].concat(json)) {
        if (block?.['@type'] !== 'BreadcrumbList') continue;
        for (const item of block.itemListElement || []) {
          const url = item?.item;
          if (typeof url !== 'string' || !url.startsWith(site)) {
            err(`breadcrumb: ${label} has a crumb with no on-site URL (${url})`);
            continue;
          }
          const to = linkPath(url.slice(site.length) || '/');
          if (!servable.has(to)) err(`breadcrumb: ${label} crumb "${item.name}" points at ${to}, which nothing serves`);
        }
      }
    }
  }

  // --- 5. no orphans --------------------------------------------------------
  //
  // A page reachable only from sitemap.xml gets crawled and reads as
  // unimportant. The footer nav covers the index pages; everything marked
  // hideFromNav has to earn a real inbound link from a list page, which is
  // exactly the link that can go missing when a generator changes.
  for (const p of pages) {
    if (p.path === '/') continue;
    const from = inbound.get(p.path);
    if (!from || !from.size) err(`orphan: ${p.path} has no inbound internal link`);
  }

  return {
    errors,
    warnings,
    stats: {
      pages: pages.length,
      rendered: rendered.size,
      aliases: aliases.size,
      links: [...inbound.values()].reduce((n, s) => n + s.size, 0),
    },
  };
}

module.exports = { auditSeo, BODY_MIN_CHARS, TITLE_MAX, DESC_MIN, DESC_MAX, DESC_SNIPPET };
