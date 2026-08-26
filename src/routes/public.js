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
  publicShowMeta,
} from "../lib/serialize.js";

/* The read-only half of the API. Three rules hold everywhere in this file:
   only `status: "published"` is visible; `?country=` is a filter, never a
   requirement (an unknown code falls back rather than erroring); and ⚠ LIST
   routes return CARD fields while DETAIL routes return everything — carrying
   detail fields in a list does not scale, and the cost lands on the homepage. */

const router = Router();

const DEFAULT_COUNTRY = COUNTRY_CODES[0];

const askedCountry = (req) => {
  const code = String(req.query.country ?? "").toLowerCase();
  return isCountryCode(code) ? code : DEFAULT_COUNTRY;
};

const published = (code) => ({ status: "published", ...countryQuery(code) });

/* `limit` is capped so a crafted `?limit=100000` cannot ask this service to
   serialise a whole collection into one response. */
const MAX_LIMIT = 50;

const paging = (req, fallback) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || fallback));
  return { page, limit, skip: (page - 1) * limit };
};

/* `total` is what lets the site render a pager without asking twice. */
const paged = async (model, where, { sort, skip, limit, page }, serialize) => {
  const [items, total] = await Promise.all([
    model.find(where).sort(sort).skip(skip).limit(limit).lean(),
    model.countDocuments(where),
  ]);
  return { items: items.map(serialize), total, page, limit };
};

/* A minute of shared caching takes the steady-state load off Atlas' free tier.
   ⚠ An editor's publish therefore reaches the site within a minute, not
   instantly — worth knowing before someone reports it as a bug. */
const cacheable = (res) => {
  res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
};

/* ⚠ "Upcoming" is decided by the VISITOR's calendar day via `?from=`, not the
   server's clock — a server in UTC would call tonight's event past for someone
   for whom it is still this morning. It also keeps the edge cache honest, since
   each day is then its own cache entry. Absent `from` means no date filter. */
const fromFilter = (req) => {
  const from = String(req.query.from ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(from) ? { date: { $gte: from } } : {};
};

/* ⚠ Filtering happens HERE, not in the browser: page one of "all posts" is not
   page one of "Iwan Kids posts". "__none" is a sentinel meaning "open to the
   whole community" — an empty `?programme=` cannot be told apart from no filter
   — and matches both null and missing. */
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
    /* Soonest first, so paging puts the next event on page one. */
    { sort: { date: 1 }, ...paging(req, fallbackLimit) },
    publicEventCard
  );

const listBlogs = (req, code, fallbackLimit) =>
  paged(
    Blog,
    { ...published(code), ...programmeFilter(req) },
    /* Newest first, undated last — "" and missing sort below any real date. */
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

/* The single promo to show, or null. More than one can be eligible, so the tie
   is broken deliberately rather than by whatever Mongo returns first: naming
   this country beats global, then higher `priority`, then most recently
   edited. */
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

/* Everything the site needs before first paint: the first page of each list in
   card projection, plus the promo. ⚠ BOUNDED — six of each, whatever the
   database holds, so the homepage does not get slower with each post written.
   One request rather than four because all of it is needed on first paint. */
const BOOT_LIMIT = 6;

router.get(
  "/content",
  wrap(async (req, res) => {
    const country = askedCountry(req);
    /* Always page one, whatever ?page= says — that belongs to the lists. */
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
    /* One list, under `items`, like every other paged route. It used to also
       repeat it as `episodes`, which shipped the same array twice. */
    res.json({ ...publicShowMeta(show), ...episodes });
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

/* ⚠ The ONLY routes returning heavy fields — `details`, `agenda`, `html`. */

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
