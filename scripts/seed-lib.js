/* Reads the public site's static content and writes it into the database.

   ⚠ It reads the site's own content/base/*.js files rather than a transcribed
   copy kept here. Those files are plain data with no imports, so they can be
   imported directly, and reading them means the seed cannot drift from what the
   site currently ships — which is the whole point of seeding: afterwards the
   CMS serves exactly what the static files served, and the cutover changes
   nothing a visitor can see.

   The logic lives here rather than in scripts/seed.js so that the CLI and the
   in-memory dev server can both use it without one shelling out to the other. */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { access } from "node:fs/promises";
import { Event } from "../src/models/Event.js";
import { Blog } from "../src/models/Blog.js";
import { PodcastEpisode, PodcastShow } from "../src/models/Podcast.js";
import { Promo } from "../src/models/Promo.js";
import { blocksToHtml } from "../src/lib/html.js";

/* ⚠ The static events in the site's content files predate registration forms
   and carry none — but a PUBLISHED event must have one (see
   validators/form.js), so seeding them bare would create six events that could
   not be saved again from the admin without one being added first.

   This is the form every event gets to start with: who is coming, and how to
   reach them. It is deliberately the minimum — anything beyond it is a question
   about a specific event, which is exactly what the builder is for. */
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

/* The site stores a country as a single code, a list of codes, or nothing at
   all for "everywhere". This API stores a list, where EMPTY means everywhere.
   One direction of that translation lives here; the other is `countryOf` in
   src/lib/countries.js. */
const toCountries = (country) => {
  if (!country) return [];
  return Array.isArray(country) ? [...country] : [country];
};

/* Upsert on the slug so re-running is safe, and so an edit made in the CMS to a
   document that also exists in the static files is OVERWRITTEN — a re-seed is a
   deliberate reset of that record to what the site ships, not a merge. */
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
    /* The static files ARE the live site, so everything in them is published.
       Only the promo below is seeded as a draft, and for a stated reason. */
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

    /* ⚠ Only when the source has none of its own — a re-seed must not wipe a
       form an editor has since built for this event. */
    form: e.form?.length ? e.form : DEFAULT_FORM,
  }));

const mapBlogs = (BLOGS = []) =>
  BLOGS.map((b) => ({
    slug: b.id,
    /* ⚠ Blogs carry no country on the site today — there is one list for
       everywhere — so they seed as GLOBAL (an empty list) rather than being
       assigned to a country nobody has decided on. Filing a post under India or
       Canada is now an edit in the CMS. */
    countries: toCountries(b.country),
    status: "published",
    title: b.title ?? "",
    /* ⚠ Two posts genuinely have no date on the live site. No date is invented
       for them here either — they sort last and render without one. */
    date: b.date ?? "",
    programme: b.programme ?? null,
    img: b.img ?? "",
    excerpt: b.excerpt ?? "",

    /* The site's static posts are still `[kind, text]` pairs — that is the
       format they were transcribed in. They become HTML on the way in, since
       HTML is what the CMS stores now. Consecutive bullets are folded into one
       list, which is what they always meant. */
    html: blocksToHtml(b.body ?? []),

    /* ⚠ The original pairs are kept alongside, untouched. They are no longer
       read (the public payload derives `body` from the HTML), but a seed that
       threw away the only copy of the source format would be a one-way door. */
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
      /* ⚠ DRAFT, unlike everything else. The site's promo.js is placeholder
         copy for a campaign that does not exist — its own header says so — and
         seeding it as published would put invented marketing on the live site
         the moment the CMS is switched on. It is here so an editor has a worked
         example to copy; publishing it is a deliberate act. */
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

   `only` limits the run to some of SEEDABLE. That matters because a seed
   OVERWRITES: re-running it to refresh one content type would otherwise also
   reset every edit an editor has made to the other three, back to whatever the
   static files say. Once real content is being written in the CMS, a targeted
   `--only=blogs` is the safe form of this command and the whole-database one is
   the exception. */
export async function seedInto({
  source = DEFAULT_SOURCE,
  reset = false,
  only = SEEDABLE,
} = {}) {
  const wants = (type) => only.includes(type);

  /* Only the files that are actually going to be used are read, so pointing
     --from at a partial folder works for the types it does contain. */
  const [events, blogs, podcastModule, promoModule] = await Promise.all([
    wants("events") ? load(source, "events.js").then((m) => mapEvents(m.EVENTS)) : [],
    wants("blogs") ? load(source, "blogs.js").then((m) => mapBlogs(m.BLOGS)) : [],
    wants("podcast")
      ? load(source, "podcast.js").then((m) => mapPodcast(m.PODCAST))
      : { show: null, episodes: [] },
    wants("promos") ? load(source, "promo.js").then((m) => mapPromo(m.PROMO)) : [],
  ]);

  if (reset) {
    /* ⚠ Content only, and only the types being seeded. User accounts are never
       dropped — losing every login because of a re-seed would be a spectacular
       own goal. */
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
