import { countryOf } from "./countries.js";

/* Two shapes, one set of documents. PUBLIC serialisers reproduce the site's
   existing content contract, which is why `id` holds the SLUG. ADMIN serialisers
   are the storage shape, where `id` is the Mongo `_id`. Nothing in the admin
   ever sees the public shape, so the two `id`s never meet. */

/* Drops valueless keys, so the payload matches a hand-written content file
   rather than shipping a wall of nulls. Empty ARRAYS are kept: `agenda: []`
   says "no running order", where a missing key would make a consumer guess. */
const compact = (obj) =>
  Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== "")
  );

/* ⚠ CARD vs DETAIL is the load-bearing distinction here. A card is what a
   listing renders; a detail is the whole record. Serving detail fields in a
   list is what made the old payload 64 KB for thirteen posts, and the cost
   lands on the homepage. Lists use the card serialisers; only `/…/:slug` uses
   these. A card is a strict SUBSET of a detail, so a component written against
   one keeps working if handed the other. */

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
    /* ⚠ `|| "free"`, twice over: pre-admission documents have no value, and ""
       would be dropped by compact() — the site must never have to guess. */
    admission: doc.admission || "free",
    img: doc.img,
    summary: doc.summary,
    /* ⚠ Not the form itself — only whether there IS one, so a card can show a
       Register button without fetching the whole event. */
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
    admission: doc.admission || "free",
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

    /* Already sanitised on write, so the site renders it directly with
       dangerouslySetInnerHTML — see lib/html.js. ⚠ The old `[kind, text]` pairs
       are gone from this payload (45% of /api/content, for no reader). `body` is
       still on the DOCUMENT as the preserved source, just not served. */
    html: doc.html ?? "",
  });

export const publicEpisode = (doc) =>
  compact({
    id: doc.slug,
    country: countryOf(doc.countries),
    title: doc.title,
    author: doc.author,
    programme: doc.programme,
    audio: doc.audio,
    video: doc.video,
    length: doc.length,
    cover: doc.cover,
    publishedOn: doc.publishedOn,
  });

/* The show's own fields. The paged route carries its episodes as `items`, so it
   takes this rather than publicShow, which would add an empty `episodes`. */
export const publicShowMeta = (show) =>
  compact({
    title: show?.title ?? "",
    description: show?.description ?? "",
    cover: show?.cover ?? "",
  });

export const publicShow = (show, episodes = []) => ({
  ...publicShowMeta(show),
  episodes: episodes.map(publicEpisode),
});

export const publicPromo = (doc) =>
  doc
    ? compact({
        /* PromoPopup keys its dismissal on this, so a new slug re-shows. */
        id: doc.slug,
        eyebrow: doc.eyebrow,
        heading: doc.heading,
        mark: doc.mark,
        body: doc.body,
        cta: doc.cta?.label ? { label: doc.cta.label, to: doc.cta.to || "/" } : null,
        dismiss: doc.dismiss,
      })
    : null;

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
  /* ⚠ Also here — the admin PUTs the whole record back, so leaving this out
     would reset every saved event to the default. */
  admission: doc.admission || "free",
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
  programme: doc.programme ?? null,
  audio: doc.audio,
  video: doc.video ?? "",
  length: doc.length ?? null,
  cover: doc.cover,
  order: doc.order ?? 0,
  publishedOn: doc.publishedOn ?? "",
});

export const adminShow = (doc) => ({
  title: doc?.title ?? "",
  description: doc?.description ?? "",
  cover: doc?.cover ?? "",
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
});

/* ⚠ `answers` keeps the label and type each answer was GIVEN under, not the
   question's current wording — see models/Registration.js. Reading from the
   event's current form would silently rewrite history on every form edit. */
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
  /* Null = no record (pre-feature rows) — never render it as "No". */
  photoConsent: doc.photoConsent ?? null,
  /* Null means no record — sent-and-unstamped and never-sent are
     indistinguishable, so the CMS says "unknown" rather than "never". */
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

/* The builder needs the stored shape, options as objects and all — same as an
   event's form. */
const APPLY_COPY = [
  "eyebrow",
  "heading",
  "mark",
  "intro",
  "formHeading",
  "submitLabel",
  "subscribeLabel",
  "doneHeading",
  "doneBody",
];

export const adminApplyForm = (doc) => ({
  id: String(doc._id),
  kind: doc.kind,
  name: doc.name,
  countries: doc.countries ?? [],
  active: Boolean(doc.active),
  isDefault: Boolean(doc.isDefault),
  updatedAt: doc.updatedAt,
  ...Object.fromEntries(APPLY_COPY.map((key) => [key, doc?.[key] ?? ""])),
  fields: (doc.fields ?? []).map((f) => ({
    key: f.key,
    type: f.type,
    label: f.label,
    help: f.help ?? "",
    placeholder: f.placeholder ?? "",
    required: Boolean(f.required),
    options: (f.options ?? []).map((o) => ({ label: o.label })),
  })),
  updatedAt: doc?.updatedAt ?? null,
});

/* ⚠ No Mongo bookkeeping — just what a renderer needs to draw the question and
   validate the answer. Same contract as publicEvent's `form`. */
/* ⚠ The ACTIVE form, verbatim. No merging with anything the site ships: what
   the CMS holds is what the page renders, so an editor can see the page in the
   builder rather than guessing which half wins. Null when nothing is active —
   see lib/applyForms.js. */
export const publicApplyForm = (resolved) => ({
  kind: resolved.kind,
  ...Object.fromEntries(APPLY_COPY.map((key) => [key, resolved[key] ?? ""])),
  fields: (resolved.fields ?? []).map((f) => ({
    key: f.key,
    type: f.type,
    label: f.label,
    ...(f.help ? { help: f.help } : {}),
    ...(f.placeholder ? { placeholder: f.placeholder } : {}),
    ...(f.required ? { required: true } : {}),
    ...(f.options?.length ? { options: f.options.map((o) => o.label) } : {}),
  })),
});

export const adminAudience = (doc) => ({
  id: String(doc._id),
  email: doc.email,
  name: doc.name ?? "",
  mobile: doc.mobile ?? "",
  subscribed: Boolean(doc.subscribed),
  sources: doc.sources ?? [],
  country: doc.country ?? null,
  note: doc.note ?? "",
  messages: (doc.messages ?? []).map((m) => ({
    subject: m.subject ?? "",
    body: m.body ?? "",
    country: m.country ?? null,
    at: m.at,
  })),
  firstSeenAt: doc.createdAt,
  lastSeenAt: doc.lastSeenAt ?? doc.updatedAt,
});

export const adminApplication = (doc) => ({
  id: String(doc._id),
  kind: doc.kind,
  email: doc.email,
  name: doc.name ?? "",
  mobile: doc.mobile ?? "",
  role: doc.role ?? "",
  country: doc.country,
  status: doc.status,
  note: doc.note ?? "",
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
