import { countryOf } from "./countries.js";

/* Two shapes, one set of documents.

   PUBLIC serialisers reproduce the public site's existing content contract
   exactly — the same field names its static content/base/*.js files use, so
   `resolveContent` can swap file for API without a single component changing.
   That is why the identity field is `id` and holds the SLUG, not the Mongo id,
   and why the agenda and blog body come back as pairs.

   ADMIN serialisers are the storage shape: the Mongo `_id` (as `id`, since the
   admin addresses documents by it), the `countries` array as stored, the draft
   status, and the timestamps. Nothing in the admin ever sees the public shape,
   so the two `id`s never meet. */

/* Drops keys that carry no value, so the payload matches a hand-written content
   file — where a field a thing does not have is simply absent — rather than
   shipping a wall of nulls. Empty ARRAYS are kept: `agenda: []` says "no
   running order", and a missing key would make a consumer guess. */
const compact = (obj) =>
  Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== "")
  );

/* ── public ─────────────────────────────────────────────────────────────── */

/* ── card vs detail ─────────────────────────────────────────────────────── */

/* ⚠ The most load-bearing distinction in this file.

   A CARD is what a listing renders: enough to draw the tile and link to it.
   A DETAIL is the whole record.

   Serving detail fields in a list is what made the old single payload 64 KB for
   thirteen posts — a post's `html` alone was 81% of it, and an event carries
   `details` plus a whole `agenda` that only its own page reads. The cost of
   getting this wrong lands on the homepage, and it grows with every row an
   editor adds. Lists use the card serialisers; only `/…/:slug` uses these.

   The card is a strict SUBSET of the detail shape, so a component written
   against a card keeps working if it is later handed a detail. */

export const publicEventCard = (doc) =>
  compact({
    id: doc.slug,
    country: countryOf(doc.countries),
    title: doc.title,
    kind: doc.kind,
    date: doc.date,
    start: doc.start,
    end: doc.end,
    venue: doc.venue,
    programme: doc.programme,
    spots: doc.spots,
    img: doc.img,
    summary: doc.summary,
    /* ⚠ Deliberately NOT the form — a listing draws a card, it does not draw a
       registration form. Same rule as `details` and `agenda`. What it DOES say
       is whether there is one, so a card can show a Register button without
       fetching the whole event to find out. */
    ...(doc.form?.length ? { hasForm: true } : {}),
  });

/* ⚠ No `html`. That is the entire reason this exists. */
export const publicBlogCard = (doc) =>
  compact({
    id: doc.slug,
    country: countryOf(doc.countries),
    title: doc.title,
    programme: doc.programme,
    date: doc.date,
    img: doc.img,
    excerpt: doc.excerpt,
  });

export const publicEvent = (doc) =>
  compact({
    id: doc.slug,
    country: countryOf(doc.countries),
    kind: doc.kind,
    spots: doc.spots,
    address: doc.address,
    title: doc.title,
    date: doc.date,
    start: doc.start,
    end: doc.end,
    venue: doc.venue,
    programme: doc.programme,
    coords: doc.coords?.length === 2 ? doc.coords : null,
    img: doc.img,
    summary: doc.summary,
    details: doc.details,
    agenda: (doc.agenda ?? []).map((row) => [row.time, row.label]),

    /* ⚠ The public form carries no Mongo bookkeeping — just what a renderer
       needs to draw the question and validate the answer. */
    form: (doc.form ?? []).map((f) => ({
      key: f.key,
      type: f.type,
      label: f.label,
      ...(f.help ? { help: f.help } : {}),
      ...(f.placeholder ? { placeholder: f.placeholder } : {}),
      ...(f.required ? { required: true } : {}),
      ...(f.options?.length ? { options: f.options.map((o) => o.label) } : {}),
    })),
  });

export const publicBlog = (doc) =>
  compact({
    id: doc.slug,
    country: countryOf(doc.countries),
    title: doc.title,
    programme: doc.programme,
    date: doc.date,
    img: doc.img,
    excerpt: doc.excerpt,

    /* The post. Already sanitised on write, so the site renders it directly
       with dangerouslySetInnerHTML — see the note in lib/html.js.

       ⚠ The old `[kind, text]` pairs are GONE from this payload. They were a
       compatibility shim for the window between the CMS storing HTML and the
       site being taught to render it; the site now reads `html`, and carrying
       both was 45% of the /api/content response for no reader. The `body`
       blocks are still on the DOCUMENT — that is the preserved pre-conversion
       source — they are simply no longer served. */
    html: doc.html ?? "",
  });

export const publicEpisode = (doc) =>
  compact({
    id: doc.slug,
    country: countryOf(doc.countries),
    title: doc.title,
    author: doc.author,
    audio: doc.audio,
    length: doc.length,
    cover: doc.cover,
    publishedOn: doc.publishedOn,
  });

export const publicShow = (show, episodes = []) => ({
  ...compact({
    title: show?.title ?? "",
    description: show?.description ?? "",
    cover: show?.cover ?? "",
  }),
  episodes: episodes.map(publicEpisode),
});

export const publicPromo = (doc) =>
  doc
    ? compact({
        /* PromoPopup remembers a dismissal under this, so it is the slug —
           a new campaign gets a new slug and shows again to everyone. */
        id: doc.slug,
        eyebrow: doc.eyebrow,
        heading: doc.heading,
        mark: doc.mark,
        body: doc.body,
        cta: doc.cta?.label ? { label: doc.cta.label, to: doc.cta.to || "/" } : null,
        dismiss: doc.dismiss,
      })
    : null;

/* ── admin ──────────────────────────────────────────────────────────────── */

const adminBase = (doc) => ({
  id: String(doc._id),
  slug: doc.slug,
  countries: doc.countries ?? [],
  status: doc.status,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

export const adminEvent = (doc) => ({
  ...adminBase(doc),
  title: doc.title,
  kind: doc.kind,
  date: doc.date,
  start: doc.start,
  end: doc.end,
  venue: doc.venue,
  address: doc.address,
  coords: doc.coords ?? null,
  programme: doc.programme ?? null,
  spots: doc.spots ?? null,
  img: doc.img,
  summary: doc.summary,
  details: doc.details,
  agenda: doc.agenda ?? [],
  /* The builder needs the stored shape, options as objects and all. */
  form: (doc.form ?? []).map((f) => ({
    key: f.key,
    type: f.type,
    label: f.label,
    help: f.help ?? "",
    placeholder: f.placeholder ?? "",
    required: Boolean(f.required),
    options: (f.options ?? []).map((o) => ({ label: o.label })),
  })),
});

export const adminBlog = (doc) => ({
  ...adminBase(doc),
  title: doc.title,
  date: doc.date ?? "",
  programme: doc.programme ?? null,
  img: doc.img,
  excerpt: doc.excerpt,
  /* ⚠ The editor sees `html` and nothing else. `body` is deliberately NOT sent:
     it is a derived, deprecated view, and putting it in the form payload would
     invite someone to start editing the thing that is no longer the source. */
  html: doc.html ?? "",
});

export const adminEpisode = (doc) => ({
  ...adminBase(doc),
  title: doc.title,
  author: doc.author,
  audio: doc.audio,
  length: doc.length ?? null,
  cover: doc.cover,
  order: doc.order ?? 0,
  publishedOn: doc.publishedOn ?? "",
});

export const adminShow = (doc) => ({
  title: doc?.title ?? "",
  description: doc?.description ?? "",
  cover: doc?.cover ?? "",
  updatedAt: doc?.updatedAt ?? null,
});

export const adminPromo = (doc) => ({
  ...adminBase(doc),
  name: doc.name,
  eyebrow: doc.eyebrow,
  heading: doc.heading,
  mark: doc.mark,
  body: doc.body,
  cta: { label: doc.cta?.label ?? "", to: doc.cta?.to ?? "/" },
  dismiss: doc.dismiss,
  startsAt: doc.startsAt ?? "",
  endsAt: doc.endsAt ?? "",
  priority: doc.priority ?? 0,
});

/* A registration, as the CMS reads it.

   ⚠ `answers` keeps the label and type each answer was GIVEN under, not the
   question's current wording — see models/Registration.js. Rendering from the
   event's current form instead would silently rewrite history every time an
   editor edits the form. */
export const adminRegistration = (doc) => ({
  id: String(doc._id),
  event: String(doc.event),
  eventSlug: doc.eventSlug,
  eventTitle: doc.eventTitle ?? "",
  country: doc.country,
  status: doc.status,
  name: doc.name ?? "",
  email: doc.email ?? "",
  note: doc.note ?? "",
  /* Null means no confirmation is on record — either none was sent or the
     registration predates the field. The CMS says "unknown" rather than
     "never", because it cannot tell those apart. */
  confirmationSentAt: doc.confirmationSentAt ?? null,
  confirmationSentCount: doc.confirmationSentCount ?? 0,
  answers: (doc.answers ?? []).map((a) => ({
    key: a.key,
    label: a.label,
    type: a.type,
    value: a.value ?? null,
  })),
  submittedAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

export const adminUser = (doc) => ({
  id: String(doc._id),
  email: doc.email,
  username: doc.username ?? "",
  name: doc.name,
  role: doc.role,
  countries: doc.countries ?? [],
  active: doc.active,
  lastLoginAt: doc.lastLoginAt ?? null,
  createdAt: doc.createdAt,
});
