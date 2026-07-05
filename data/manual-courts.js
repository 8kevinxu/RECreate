// Hand-curated courts that are fully static (no upstream schedule to refresh).
//
// scripts/build-indoor-courts.js regenerates data/courts.js from sfrecpark.org +
// DataSF and will clobber anything added there. Courts in THIS file are merged in
// at runtime by lib/useCourts.js (deduped by id) and are never overwritten.
//
// Courts whose schedules CAN be refreshed from an upstream source get their own
// generated file + build script instead — e.g. the San Bruno RAC lives in
// data/sanbruno-court.js (scripts/build-sanbruno-court.js).
//
// Same schema as data/courts.js. Times are minutes-from-midnight; arrays are
// indexed 0=Sun..6=Sat. `schedule[i]` = facility hours [openMin,closeMin] or null;
// dropins[sport][i] = drop-in blocks [[startMin,endMin], ...].
// Optional `disclaimer` overrides the default "verify on sfrecpark.org" footnote.

// ---------------------------------------------------------------------------
// Golf — the 6 SFRPD courses (⛳ facility view; see lib/sports.js GOLF).
//
// Courses have no drop-in schedule, so each is modeled as playable over an
// approximate daylight window every day (first tee ~6:30 AM, last light ~8 PM);
// the card's disclaimer says so. The `golf` block is what the court card
// renders: holes/par/yards, curated green fees, and the tee-time booking link.
// Facts curated from sfrecpark.org/1384/Rates-and-Tee-Times + each course's
// site, July 2026 — fees change ~annually, bump by hand (like the pool FEES
// tables). Coordinates from DataSF ib5c-xgwu (clubhouse locations).
// ---------------------------------------------------------------------------

// Daylight week: the same [start,end] block every day, as hours + dropin weeks.
const DAYLIGHT = [390, 1200]; // ~6:30 AM – 8:00 PM
const WEEK_HOURS = Array(7).fill(DAYLIGHT);
const WEEK_BLOCKS = Array(7).fill([DAYLIGHT]);

const GOLF_DISCLAIMER =
  'Hours are approximate (roughly dawn to dusk); fees as of July 2026 — verify rates and book tee times with the course.';

const golfCourse = (c) => ({
  indoor: false,
  schedule: WEEK_HOURS,
  dropins: { golf: WEEK_BLOCKS },
  scheduleSource: 'curated',
  source: 'sfrecpark-golf',
  disclaimer: GOLF_DISCLAIMER,
  ...c,
});

export const MANUAL_COURTS = [
  golfCourse({
    id: 'tpc-harding-park-golf',
    name: 'TPC Harding Park',
    address: '99 Harding Rd',
    neighborhood: 'Lake Merced',
    lat: 37.722378,
    lng: -122.490198,
    notes:
      'Toptracer driving range, putting and short-game areas, club rentals, restaurant.',
    golf: {
      holes: 18,
      par: 72,
      yards: '7,169',
      range: true,
      beginner: false,
      desc:
        'Built in 1925 among towering Monterey cypress on the shore of Lake Merced and restored into SF’s championship flagship — host of the 2009 Presidents Cup and the 2020 PGA Championship.',
      fees: [
        'Dynamic pricing — SF Resident Card holders are guaranteed the lowest rate',
        'Driving range: $5–$22.50 ball buckets (Toptracer)',
      ],
      bookUrl: 'https://hardingpark.ezlinksgolf.com/index.html#!/search',
      website: 'https://tpc.com/hardingpark/',
    },
  }),
  golfCourse({
    id: 'fleming-9-golf',
    name: 'Fleming 9 (TPC Harding Park)',
    address: '99 Harding Rd',
    neighborhood: 'Lake Merced',
    lat: 37.724703,
    lng: -122.488408,
    notes: 'Shares Harding Park’s Toptracer driving range and clubhouse.',
    golf: {
      holes: 9,
      par: 30,
      yards: '2,165',
      range: true,
      beginner: true,
      desc:
        'A Jack Fleming short course (1961) tucked inside Harding Park under the same cypress canopy — six par-3s and three par-4s, perfect for beginners, juniors, and a quick evening loop.',
      fees: [
        'Standard $33 wkdy · $38 wknd',
        'SF resident $28 · $30',
        'Junior (resident) $14 · $17',
      ],
      bookUrl: 'https://hardingpark.ezlinksgolf.com/index.html#!/search',
      website: 'https://tpc.com/hardingpark/',
    },
  }),
  golfCourse({
    id: 'lincoln-park-golf',
    name: 'Lincoln Park Golf Course',
    address: '300 34th Ave',
    neighborhood: 'Outer Richmond',
    lat: 37.782275,
    lng: -122.49432,
    notes: 'Practice putting green; club and cart rentals (cart-path-only course).',
    golf: {
      holes: 18,
      par: 68,
      yards: '5,416',
      range: false,
      beginner: false,
      desc:
        'Golf has been played on these Lands End headlands since 1902, making Lincoln one of the West’s oldest municipal courses — short, hilly, and capped by the par-3 17th with its postcard Golden Gate Bridge view.',
      fees: [
        'Standard $62 wkdy · $69 wknd',
        'SF resident $48 · $54',
        'Twilight from $44',
      ],
      bookUrl: 'https://lincolnpark.ezlinksgolf.com/index.html#/search',
      website: 'http://www.lincolnparkgolfcourse.com/',
    },
  }),
  golfCourse({
    id: 'golden-gate-park-golf',
    name: 'Golden Gate Park Golf Course',
    address: '970 47th Ave',
    neighborhood: 'Outer Richmond',
    lat: 37.769057,
    lng: -122.506515,
    notes: 'Ball cage, club rentals, clubhouse café.',
    golf: {
      holes: 9,
      par: 27,
      yards: '1,357',
      range: false,
      beginner: true,
      desc:
        'A 1951 pitch-and-putt par-3 in the dunes at the park’s ocean end, freshly renovated in 2023 — the friendliest (and cheapest) place in town to pick up the game, with a full loop taking about an hour.',
      fees: [
        'Standard $45 wkdy · $55 wknd',
        'SF resident $28 · $30',
        'Junior $16 · $19',
      ],
      bookUrl: 'https://www.goldengateparkgolf.com/tee-times/',
      website: 'https://www.goldengateparkgolf.com/',
    },
  }),
  golfCourse({
    id: 'gleneagles-golf',
    name: 'Gleneagles Golf Course',
    address: '2100 Sunnydale Ave',
    neighborhood: 'McLaren Park',
    lat: 37.716001,
    lng: -122.424405,
    notes: 'Practice green and a well-loved clubhouse bar.',
    golf: {
      holes: 9,
      par: 36,
      yards: '3,260',
      range: false,
      beginner: false,
      desc:
        'Jack Fleming’s famously demanding 9 (1962) on the windy slopes of McLaren Park — long par-4s, uneven lies, and a devoted local following; play it twice from different tees for a full 18.',
      fees: ['Standard $40 wkdy · $44 wknd', 'SF resident $35 · $40', 'Junior $28'],
      bookUrl: 'https://gleneagles-gc-mclaren-park.book.teeitup.com/',
      website: 'https://www.gleneaglesgolfsf.com/',
    },
  }),
  golfCourse({
    id: 'sharp-park-golf',
    name: 'Sharp Park Golf Course',
    address: 'Sharp Park Rd & Hwy 1, Pacifica',
    neighborhood: 'Pacifica',
    lat: 37.624964,
    lng: -122.488817,
    notes:
      'SFRPD-owned though it sits in Pacifica. Driving range, practice green, restaurant.',
    golf: {
      holes: 18,
      par: 72,
      yards: '6,494',
      range: true,
      beginner: false,
      desc:
        'A 1932 seaside links by Alister MacKenzie — architect of Augusta National and Cypress Point — running behind the sea wall in Pacifica; Golden Age design at a municipal price.',
      fees: [
        'Standard $78 wkdy · $86 wknd',
        'SF resident $62 · $68',
        'Twilight from $48',
      ],
      bookUrl: 'https://sharppark.ezlinksgolf.com/index.html#/search',
      website: 'https://sharpparkgc.com/',
    },
  }),
];

export default MANUAL_COURTS;
