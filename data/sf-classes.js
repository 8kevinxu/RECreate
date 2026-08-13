// Hand-written aggregator for San Francisco's program catalog — the SF analogue of
// data/cities/index.js, which does the same job for the other cities.
//
// SF's programs come from TWO sources that are generated independently and refresh
// on different schedules:
//   - data/classes.js    ActiveNet registered classes & drop-ins (build:classes, 6h)
//   - data/volunteer.js  Rec & Park volunteer workparties (build:volunteer, 6h)
//
// They share one record shape, so everything downstream (browse, filters, search,
// recommendations, ClassDetail, the prerendered /classes page) treats them the
// same. Merging HERE rather than in either generated file keeps each build owning
// exactly one output — a failed volunteer scrape can never blank the class catalog,
// and neither build has to know the other exists.
//
// Volunteer records carry `source: 'sfrpd-volunteer'`. Anything that validates a
// record against the live ActiveNet catalog must skip them — they aren't in it.

import { CLASSES } from './classes';
import { VOLUNTEER } from './volunteer';

export const SF_CLASSES = [...CLASSES, ...VOLUNTEER];

export default SF_CLASSES;
