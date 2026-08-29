/* Reads the public site's static content and writes it into the database.

   ⚠ It imports the site's own content/base/*.js rather than a transcribed copy,
   so the seed cannot drift from what the site ships — the point being that
   after a seed the CMS serves exactly what the static files did.

   Here rather than in seed.js so the CLI and the in-memory dev server can both
   use it without one shelling out to the other. */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { access } from "node:fs/promises";
import { Event } from "../src/models/Event.js";
import { Blog } from "../src/models/Blog.js";
import { PodcastEpisode, PodcastShow } from "../src/models/Podcast.js";
import { ensureDefaultApplyForms } from "../src/lib/applyForms.js";
import { Promo } from "../src/models/Promo.js";
import { blocksToHtml } from "../src/lib/html.js";

/* ⚠ The static events predate registration forms and carry none, but a
   PUBLISHED event must have one (validators/form.js) — seeded bare, they could
   not be saved again from the admin. This is the deliberate minimum: who is
   coming and how to reach them. */
const DEFAULT_FORM = [
  {
    key: "full_name",
    type: "name",
    label: "Your full name",
    help: "",
    placeholder: "",
    required: true,
    options: [],
  },
  {
    key: "email",
    type: "email",
    label: "E-mail",
    help: "We will send your confirmation here.",
    placeholder: "ex: myname@example.com",
    required: true,
    options: [],
  },
  {
    key: "phone",
    type: "phone",
    label: "Phone",
    help: "",
    placeholder: "(000) 000-0000",
    required: false,
    options: [],
  },
  {
    key: "people",
    type: "number",
    label: "How many of you are coming?",
    help: "Including yourself.",
    placeholder: "1",
    required: false,
    options: [],
  },
  {
    key: "anything_else",
    type: "textarea",
    label: "Anything we should know?",
    help: "Access needs, dietary requirements, or a question.",
    placeholder: "",
    required: false,
    options: [],
  },
];

export const DEFAULT_SOURCE = path.resolve(
  process.cwd(),
  "..",
  "iwan",
  "src",
  "content",
  "base"
);

const load = async (source, file) => {
  const full = path.join(source, file);
  await access(full).catch(() => {
    throw new Error(
      `Cannot read ${full}\n` +
        `Point --from at the public site's src/content/base folder, e.g.\n` +
        `  npm run seed -- --from=../iwan/src/content/base`
    );
  });
  return import(pathToFileURL(full).href);
};

/* Site shape (a code, a list, or nothing) → API shape (a list, EMPTY meaning
   everywhere). The other direction is `countryOf` in lib/countries.js. */
const toCountries = (country) => {
  if (!country) return [];
  return Array.isArray(country) ? [...country] : [country];
};

/* ⚠ Upsert on the slug: re-running is safe, but a CMS edit to a document that
   also exists statically is OVERWRITTEN. A re-seed is a reset, not a merge. */
async function upsertAll(model, docs) {
  if (docs.length === 0) return 0;
  await model.bulkWrite(
    docs.map((doc) => ({
      updateOne: { filter: { slug: doc.slug }, update: { $set: doc }, upsert: true },
    })),
    { ordered: false }
  );
  return docs.length;
}

const mapEvents = (EVENTS = []) =>
  EVENTS.map((e) => ({
    slug: e.id,
    countries: toCountries(e.country),
    /* The static files ARE the live site. Only the promo seeds as a draft. */
    status: "published",
    title: e.title ?? "",
    kind: e.kind ?? "",
    date: e.date,
    start: e.start ?? "",
    end: e.end ?? "",
    venue: e.venue ?? "",
    address: e.address ?? "",
    coords: Array.isArray(e.coords) && e.coords.length === 2 ? e.coords : undefined,
    programme: e.programme ?? null,
    spots: Number.isFinite(e.spots) ? e.spots : null,
    img: e.img ?? "",
    summary: e.summary ?? "",
    details: e.details ?? "",
    /* [["18:30", "Doors open"], …] → [{ time, label }, …] */
    agenda: (e.agenda ?? []).map(([time, label]) => ({ time, label })),

    /* ⚠ Only when the source has none — a re-seed must not wipe a form an
       editor has since built. */
    form: e.form?.length ? e.form : DEFAULT_FORM,
  }));

const mapBlogs = (BLOGS = []) =>
  BLOGS.map((b) => ({
    slug: b.id,
    /* ⚠ Blogs carry no country on the site, so they seed as GLOBAL rather than
       being assigned to one nobody has decided on. */
    countries: toCountries(b.country),
    status: "published",
    title: b.title ?? "",
    /* ⚠ Some posts genuinely have no date. None is invented here either. */
    date: b.date ?? "",
    programme: b.programme ?? null,
    img: b.img ?? "",
    excerpt: b.excerpt ?? "",

    /* Static posts are still `[kind, text]` pairs and become HTML on the way
       in. Consecutive bullets fold into one list, as they always meant. */
    html: blocksToHtml(b.body ?? []),

    /* ⚠ The original pairs are kept, untouched and unread — throwing away the
       only copy of the source format would be a one-way door. */
    body: (b.body ?? []).map(([kind, text]) => ({ kind, text })),
  }));

const mapPodcast = (PODCAST) => {
  if (!PODCAST) return { show: null, episodes: [] };

  return {
    show: {
      title: PODCAST.title ?? "",
      description: PODCAST.description ?? "",
      cover: PODCAST.cover ?? "",
    },
    episodes: (PODCAST.episodes ?? []).map((ep, i) => ({
      slug: ep.id,
      countries: toCountries(ep.country),
      status: "published",
      title: ep.title ?? "",
      author: ep.author ?? "",
      audio: ep.audio ?? "",
      length: Number.isFinite(ep.length) ? ep.length : null,
      cover: ep.cover ?? "",
      order: i,
      publishedOn: ep.date ?? "",
    })),
  };
};

const mapPromo = (PROMO) => {
  if (!PROMO) return [];

  return [
    {
      slug: PROMO.id,
      countries: toCountries(PROMO.country),
      /* ⚠ DRAFT, unlike everything else: the site's promo.js is placeholder
         copy for a campaign that does not exist, and publishing it would put
         invented marketing live the moment the CMS is switched on. */
      status: "draft",
      name: "Example campaign (seeded placeholder)",
      eyebrow: PROMO.eyebrow ?? "",
      heading: PROMO.heading ?? "",
      mark: PROMO.mark ?? "",
      body: PROMO.body ?? "",
      cta: { label: PROMO.cta?.label ?? "", to: PROMO.cta?.to ?? "/" },
      dismiss: PROMO.dismiss ?? "",
      startsAt: "",
      endsAt: "",
      priority: 0,
    },
  ];
};

export const SEEDABLE = ["events", "blogs", "podcast", "promos"];

/* Requires an open Mongoose connection. Returns what it wrote.

   ⚠ `only` matters because a seed OVERWRITES: refreshing one content type
   otherwise resets every edit made to the other three. Once real content is
   being written, `--only=blogs` is the safe form of this command. */
export async function seedInto({
  source = DEFAULT_SOURCE,
  reset = false,
  only = SEEDABLE,
} = {}) {
  const wants = (type) => only.includes(type);

  /* Only the files being used are read, so --from can point at a partial
     folder. */
  const [events, blogs, podcastModule, promoModule] = await Promise.all([
    wants("events") ? load(source, "events.js").then((m) => mapEvents(m.EVENTS)) : [],
    wants("blogs") ? load(source, "blogs.js").then((m) => mapBlogs(m.BLOGS)) : [],
    wants("podcast")
      ? load(source, "podcast.js").then((m) => mapPodcast(m.PODCAST))
      : { show: null, episodes: [] },
    wants("promos") ? load(source, "promo.js").then((m) => mapPromo(m.PROMO)) : [],
  ]);

  if (reset) {
    /* ⚠ Content only, and only the types being seeded — user accounts are
       never dropped. */
    await Promise.all([
      wants("events") ? Event.deleteMany({}) : null,
      wants("blogs") ? Blog.deleteMany({}) : null,
      wants("podcast") ? PodcastEpisode.deleteMany({}) : null,
      wants("podcast") ? PodcastShow.deleteMany({}) : null,
      wants("promos") ? Promo.deleteMany({}) : null,
    ]);
  }

  const counts = {
    events: await upsertAll(Event, events),
    blogs: await upsertAll(Blog, blogs),
    episodes: await upsertAll(PodcastEpisode, podcastModule.episodes),
    promos: await upsertAll(Promo, promoModule),
  };

  /* ⚠ Not gated on `only`, and not affected by --reset. These are not a copy of
     anything in the static files — they are the starting forms an editor then
     owns, and re-seeding content has no business touching them. */
  counts.applyForms = (await ensureDefaultApplyForms()).length;

  if (podcastModule.show) {
    await PodcastShow.findOneAndUpdate({ key: "show" }, podcastModule.show, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    });
  }

  return counts;
}

export default seedInto;
