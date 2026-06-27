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
// `basketball[i]` = drop-in open-gym basketball blocks [[startMin,endMin], ...].
// Optional `disclaimer` overrides the default "verify on sfrecpark.org" footnote.

export const MANUAL_COURTS = [];

export default MANUAL_COURTS;
