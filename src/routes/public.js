import { Router } from "express";
import { Event } from "../models/Event.js";
import { Blog } from "../models/Blog.js";
import { PodcastEpisode, PodcastShow } from "../models/Podcast.js";
import { APPLICATION_KINDS } from "../models/Application.js";
import { resolveApplyForm } from "../lib/applyForms.js";
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
  publicApplyForm,
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

/* ⚠ UPCOMING FIRST, PAST BELOW — and the two halves run in opposite
   directions: soonest-first for what is coming up, most-recent-first for what
   has been. A plain `{ date: 1 }` cannot express that, and with the listing's
   two-month reach-back it put the oldest ended event at the top of page one,
   which read as the site showing stale content.

   Done as one aggregation rather than two queries so that `skip`/`limit` still
   page across the whole list: the boundary between upcoming and past can fall
   in the middle of a page, and stitching two paged queries together at that
   seam is where this goes wrong.

   `rank` splits them; `key` orders within each half. Negating the past half's
   epoch millis is what reverses only that half — ascending over a negated
   value is descending over the original. */
const eventsOrdering = (today) => [
  {
    $addFields: {
      __ms: { $toLong: { $toDate: "$date" } },
    },
  },
  {
    $addFields: {
      __rank: { $cond: [{ $gte: ["$date", today] }, 0, 1] },
      __key: {
        $cond: [{ $gte: ["$date", today] }, "$__ms", { $multiply: ["$__ms", -1] }],
      },
    },
  },
  { $sort: { __rank: 1, __key: 1, _id: 1 } },
];

const listEvents = async (req, code, fallbackLimit) => {
  const where = eventsQuery(req, code);
  const { page, limit, skip } = paging(req, fallbackLimit);
  /* ⚠ `?today=`, NOT `?from=`. They are different dates and conflating them
     was a real bug: the listing sends `from` two months back to reach ended
     events, so reading today out of it made every one of them "upcoming" and
     collapsed the whole thing to plain date-ascending. `from` is the floor of
     the range; `today` is where upcoming stops and past begins.

     The VISITOR's day, like every other date decision here — a server in UTC
     would put an event happening tonight in the past half for someone reading
     that morning. Falling back to the server's day only when the site did not
     say. */
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.today ?? ""))
    ? String(req.query.today)
    : new Date().toISOString().slice(0, 10);

  const [items, total] = await Promise.all([
    Event.aggregate([
      { $match: where },
      ...eventsOrdering(today),
      { $skip: skip },
      { $limit: limit },
      /* The helper fields are bookkeeping, not payload. */
      { $unset: ["__ms", "__rank", "__key"] },
    ]),
    Event.countDocuments(where),
  ]);

  return { items: items.map(publicEventCard), total, page, limit };
};

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
    { ...published(code), ...programmeFilter(req) },
    { sort: { order: 1, createdAt: 1 }, ...paging(req, fallbackLimit) },
    publicEpisode
  );

async function resolvePromo(code) {
  const today = new Date().toISOString().slice(0, 10);

  const candidates = await Promo.find({
    ...published(code),
    $and: [
      { $or: [{ startsAt: { $in: ["", null] } }, { startsAt: { $lte: today } }] },
      { $or: [{ endsAt: { $in: ["", null] } }, { endsAt: { $gte: today } }] },
    ],
  })
    .sort({ updatedAt: -1 })
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

/* The questions the volunteer and career pages ask. Cacheable like the rest —
   a form changes a few times a year, not a few times a second. */
router.get(
  "/apply-forms/:kind",
  wrap(async (req, res) => {
    const { kind } = req.params;
    if (!APPLICATION_KINDS.includes(kind)) throw notFound("No such form");

    /* ⚠ The ACTIVE form for this country, or null when an editor has none live.
       The site then says it is not taking applications — it does not invent a
       form, because what the CMS holds is what the page shows. */
    const resolved = await resolveApplyForm(kind, askedCountry(req));
    cacheable(res);
    res.json(resolved ? publicApplyForm(resolved) : { kind, active: false });
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

/* Prev/next and "more like this" for a detail page, computed from the whole
   ordered sibling list in card projection. One small find rather than a pair
   of $lt/$gt queries: those must mirror a compound sort's tie-breakers exactly
   or skip records, these collections hold dozens of documents, and the route
   is edge-cached for a minute anyway. Prev/next follow the LIST's display
   order — blogs newest-first, episodes by their running order. */
const RELATED_LIMIT = 3;

const around = (docs, index, serialize) => {
  if (index < 0) {
    /* The record exists but the sibling scan missed it (a race with an edit) —
       degrade to "no neighbours" rather than pointing at the wrong ones. */
    return { nav: { prev: null, next: null }, related: [] };
  }

  const self = docs[index];
  const others = docs.filter((_, i) => i !== index);
  /* Same programme first, then the list's own order fills the rest. */
  const related = [
    ...others.filter((d) => d.programme && d.programme === self.programme),
    ...others.filter((d) => !d.programme || d.programme !== self.programme),
  ]
    .slice(0, RELATED_LIMIT)
    .map(serialize);

  return {
    /* ⚠ Explicit nulls, attached OUTSIDE the serialisers — compact() would
       drop them, and "no neighbour" is an answer the site needs stated. */
    nav: {
      prev: index > 0 ? serialize(docs[index - 1]) : null,
      next: index < docs.length - 1 ? serialize(docs[index + 1]) : null,
    },
    related,
  };
};

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
    const code = askedCountry(req);
    const [blog, siblings] = await Promise.all([
      Blog.findOne({ slug: req.params.slug, ...published(code) }).lean(),
      Blog.find(published(code))
        .sort({ date: -1, createdAt: -1 })
        .select("slug countries title programme date img excerpt")
        .lean(),
    ]);
    if (!blog) throw notFound("No such post");

    const index = siblings.findIndex((d) => d.slug === blog.slug);
    cacheable(res);
    res.json({ ...publicBlog(blog), ...around(siblings, index, publicBlogCard) });
  })
);

router.get(
  "/podcast/:slug",
  wrap(async (req, res) => {
    const code = askedCountry(req);
    const [episode, siblings] = await Promise.all([
      PodcastEpisode.findOne({ slug: req.params.slug, ...published(code) }).lean(),
      PodcastEpisode.find(published(code))
        .sort({ order: 1, createdAt: 1 })
        .select(
          "slug countries title author programme audio video length cover publishedOn"
        )
        .lean(),
    ]);
    if (!episode) throw notFound("No such episode");

    const index = siblings.findIndex((d) => d.slug === episode.slug);
    cacheable(res);
    res.json({
      ...publicEpisode(episode),
      /* Its place in the running order — the badge number. The site used to
         derive this from the bootstrap's first page, which broke past it. */
      ...(index >= 0 ? { number: index + 1 } : {}),
      ...around(siblings, index, publicEpisode),
    });
  })
);

export default router;
