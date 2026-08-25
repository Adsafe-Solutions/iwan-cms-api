import { Router } from "express";
import { Event } from "../models/Event.js";
import { Blog } from "../models/Blog.js";
import { PodcastEpisode, PodcastShow } from "../models/Podcast.js";
import { Promo } from "../models/Promo.js";
import { notFound, wrap } from "../lib/errors.js";
import { COUNTRY_CODES, countryQuery, isCountryCode } from "../lib/countries.js";
import {
  publicBlog,
  publicBlogCard,
  publicEvent,
  publicEventCard,
  publicEpisode,
  publicPromo,
  publicShow,
} from "../lib/serialize.js";

/* The read-only half of the API — no auth, and the only half the public site
   ever calls. Every response here reproduces the site's existing content
   contract, so components downstream cannot tell the CMS from the static files.

   Three rules hold for every route in this file:

     · only `status: "published"` is ever visible. A draft exists solely inside
       the admin, so there is no preview URL to leak one.

     · `?country=` is a filter, never a requirement. An unknown or absent code
       falls back to the default country rather than erroring, because this is
       the path a visitor's page load takes and a typo'd query should not blank
       the site.

     · ⚠ LIST routes return CARD fields; DETAIL routes return everything. That
       split is the whole reason this file is shaped as it is. A blog post's
       `html` was 81% of the old single payload and only one route ever reads
       it; an event's `details` and `agenda` are the same story. Lists that
       carry detail fields do not scale, and the cost lands on the homepage. */

const router = Router();

const DEFAULT_COUNTRY = COUNTRY_CODES[0];

const askedCountry = (req) => {
  const code = String(req.query.country ?? "").toLowerCase();
  return isCountryCode(code) ? code : DEFAULT_COUNTRY;
};

const published = (code) => ({ status: "published", ...countryQuery(code) });

/* Page and size, clamped. `limit` is capped so a crafted `?limit=100000` cannot
   ask this service to serialise the whole collection into one response. */
const MAX_LIMIT = 50;

const paging = (req, fallback) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || fallback));
  return { page, limit, skip: (page - 1) * limit };
};

/* The shape every list route answers with. `total` is what lets the site render
   a pager without asking twice. */
const paged = async (model, where, { sort, skip, limit, page }, serialize) => {
  const [items, total] = await Promise.all([
    model.find(where).sort(sort).skip(skip).limit(limit).lean(),
    model.countDocuments(where),
  ]);
  return { items: items.map(serialize), total, page, limit };
};

/* Content changes a few times a week, not a few times a second. A minute of
   shared caching takes the steady-state load off Atlas' free tier, and
   stale-while-revalidate means a visitor never waits on a revalidation. An
   editor's publish therefore reaches the site within a minute, not instantly —
   which is the right trade for a marketing site and worth knowing before
   someone reports it as a bug. */
const cacheable = (res) => {
  res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
};

/* ⚠ "Upcoming" is decided by the VISITOR's calendar day, passed in as `?from=`,
   not by the server's clock. An event happens on a calendar day in its own
   place; a server in UTC deciding that today's event is already past — for
   someone for whom it is still this morning — is exactly the bug the site's own
   date handling exists to avoid. It also keeps the edge cache honest: `from` is
   part of the URL, so each day is its own cache entry rather than one stale
   response outliving the day it was built for.

   Absent `from` means no date filter at all, which is what the admin-ish
   "everything" case wants. */
const fromFilter = (req) => {
  const from = String(req.query.from ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(from) ? { date: { $gte: from } } : {};
};

/* ⚠ Filtering by programme has to happen HERE now, not in the browser. With the
   whole list in the bundle the site could filter its own array; with paging it
   cannot — page one of "all posts" is not page one of "Iwan Kids posts".

   "__none" is a real value meaning "open to the whole community", and it has to
   be a sentinel: an empty `?programme=` cannot be told apart from no filter at
   all. It matches both null and missing, since a document written before the
   field existed has neither. */
export const NO_PROGRAMME = "__none";

const programmeFilter = (req) => {
  const value = String(req.query.programme ?? "");
  if (!value) return {};
  return value === NO_PROGRAMME
    ? { programme: { $in: [null, ""] } }
    : { programme: value };
};

const eventsQuery = (req, code) => ({
  ...published(code),
  ...fromFilter(req),
  ...programmeFilter(req),
});

const listEvents = (req, code, fallbackLimit) =>
  paged(
    Event,
    eventsQuery(req, code),
    /* Ascending: soonest first is what a visitor wants, and with paging it is
       what puts the next event on page one. */
    { sort: { date: 1 }, ...paging(req, fallbackLimit) },
    publicEventCard
  );

const listBlogs = (req, code, fallbackLimit) =>
  paged(
    Blog,
    { ...published(code), ...programmeFilter(req) },
    /* Newest first, undated last — "" and missing both sort below any real date
       in a descending sort, which is the order the site wants anyway. */
    { sort: { date: -1, createdAt: -1 }, ...paging(req, fallbackLimit) },
    publicBlogCard
  );

const listEpisodes = (req, code, fallbackLimit) =>
  paged(
    PodcastEpisode,
    published(code),
    { sort: { order: 1, createdAt: 1 }, ...paging(req, fallbackLimit) },
    publicEpisode
  );

/* The single promo to show, or null.

   More than one can be eligible at once — a campaign for Canada and a global
   one, say — so the tie is broken deliberately rather than by whatever Mongo
   returns first: a promo naming this country beats a global one (a local
   campaign is more specific, so it wins), then higher `priority`, then the most
   recently edited. */
async function resolvePromo(code) {
  const today = new Date().toISOString().slice(0, 10);

  const candidates = await Promo.find({
    ...published(code),
    $and: [
      { $or: [{ startsAt: { $in: ["", null] } }, { startsAt: { $lte: today } }] },
      { $or: [{ endsAt: { $in: ["", null] } }, { endsAt: { $gte: today } }] },
    ],
  })
    .sort({ priority: -1, updatedAt: -1 })
    .lean();

  if (candidates.length === 0) return null;

  const specific = candidates.filter((p) => p.countries?.length > 0);
  return (specific.length ? specific : candidates)[0];
}

/* ── the bootstrap ──────────────────────────────────────────────────────── */

/* Everything the site needs before its first paint, and nothing more: the FIRST
   PAGE of each list in card projection, plus the promo.

   ⚠ Its size is BOUNDED — six of each, whatever the database holds. That is the
   point. The old version returned every published row with every field, so the
   homepage got slower with each post written; this one does not change size at
   all. Detail records and later pages are fetched by the route that needs them.

   Still one request rather than four: the site needs all of these on first
   paint, and four round trips would only cost four connections to say the same
   thing. Separate endpoints exist for everything that is NOT first paint. */
const BOOT_LIMIT = 6;

router.get(
  "/content",
  wrap(async (req, res) => {
    const country = askedCountry(req);
    /* The bootstrap always takes page one, whatever ?page= says — that
       parameter belongs to the list routes. */
    const boot = { ...req, query: { ...req.query, page: 1, limit: BOOT_LIMIT } };

    const [events, blogs, episodes, show, promo] = await Promise.all([
      listEvents(boot, country, BOOT_LIMIT),
      listBlogs(boot, country, BOOT_LIMIT),
      listEpisodes(boot, country, BOOT_LIMIT),
      PodcastShow.findOne({ key: "show" }).lean(),
      resolvePromo(country),
    ]);

    cacheable(res);
    res.json({
      country,
      events,
      blogs,
      podcast: {
        ...publicShow(show, []),
        episodes: episodes.items,
        total: episodes.total,
      },
      promo: publicPromo(promo),
    });
  })
);

/* ── lists ──────────────────────────────────────────────────────────────── */

router.get(
  "/events",
  wrap(async (req, res) => {
    const result = await listEvents(req, askedCountry(req), 12);
    cacheable(res);
    res.json(result);
  })
);

router.get(
  "/blogs",
  wrap(async (req, res) => {
    const result = await listBlogs(req, askedCountry(req), 6);
    cacheable(res);
    res.json(result);
  })
);

router.get(
  "/podcast",
  wrap(async (req, res) => {
    const country = askedCountry(req);
    const [show, episodes] = await Promise.all([
      PodcastShow.findOne({ key: "show" }).lean(),
      listEpisodes(req, country, 12),
    ]);
    cacheable(res);
    res.json({ ...publicShow(show, []), ...episodes, episodes: episodes.items });
  })
);

router.get(
  "/promo",
  wrap(async (req, res) => {
    const promo = await resolvePromo(askedCountry(req));
    cacheable(res);
    res.json(publicPromo(promo));
  })
);

/* ── details ────────────────────────────────────────────────────────────── */

/* ⚠ These are the ONLY routes that return the heavy fields — an event's
   `details` and `agenda`, a post's `html`. One record, fetched by the page that
   actually renders it. */

router.get(
  "/events/:slug",
  wrap(async (req, res) => {
    const event = await Event.findOne({
      slug: req.params.slug,
      ...published(askedCountry(req)),
    }).lean();
    if (!event) throw notFound("No such event");
    cacheable(res);
    res.json(publicEvent(event));
  })
);

router.get(
  "/blogs/:slug",
  wrap(async (req, res) => {
    const blog = await Blog.findOne({
      slug: req.params.slug,
      ...published(askedCountry(req)),
    }).lean();
    if (!blog) throw notFound("No such post");
    cacheable(res);
    res.json(publicBlog(blog));
  })
);

router.get(
  "/podcast/:slug",
  wrap(async (req, res) => {
    const episode = await PodcastEpisode.findOne({
      slug: req.params.slug,
      ...published(askedCountry(req)),
    }).lean();
    if (!episode) throw notFound("No such episode");
    cacheable(res);
    res.json(publicEpisode(episode));
  })
);

export default router;
