import { z } from "zod";
import { ROLES } from "../models/User.js";
import { Promo } from "../models/Promo.js";
import * as f from "./fields.js";
import { badRequest } from "../lib/errors.js";
import { sanitize } from "../lib/html.js";
import { formInput, assertFormIsCoherent } from "./form.js";
import { assertPublishable } from "./publishing.js";

/* The write shapes. Unknown keys are STRIPPED rather than rejected, so the
   admin can PUT a whole record straight back without peeling off `id` and
   `createdAt` first. */

export const eventInput = z.object({
  slug: f.slug,
  countries: f.countries,
  status: f.status,

  title: z.string().trim().min(1, "A title is required").max(200),
  kind: f.text(80),

  date: f.day,
  start: f.time,
  end: f.time,

  venue: f.text(200),
  address: f.text(300),
  coords: f.coords,

  programme: f.programme,
  spots: z.union([z.number().int().min(0), z.null()]).default(null),
  admission: z.enum(["free", "ticket"]).default("free"),
  img: f.url,

  summary: f.text(400),
  details: f.longText(),
  agenda: z.array(f.agendaRow).max(40).default([]),

  /* Rules needing the WHOLE form (duplicate keys, empty choice lists) run in
     `beforeSave` — a per-field schema cannot check a field's siblings. */
  form: formInput,
});

/* Both run on the MERGED event, so a PATCH changing only `status` is still
   checked against the form already stored. */
/* ⚠ Everything the SITE cannot render honestly without. Each of these leaves a
   visible hole: no photo is a broken image on the card, no venue sends the map
   to the office address, no summary is a blank card. What is deliberately NOT
   here is anything with a real "none" — `spots` (uncapped), `programme` (open
   to all), `kind`, `address` and `coords` (the map falls back to the venue). */
const EVENT_TO_PUBLISH = [
  /* ⚠ In the same pass as the rest, not a separate throw before it: an editor
     publishing a half-written event should be told everything it needs once,
     rather than fixing the form, saving, and being told about the summary. */
  {
    field: "form",
    label: "Registration form",
    message:
      "Add at least one question before publishing — a live event with nowhere to register is worse than an unpublished one.",
  },
  { field: "kind", label: "Type" },
  { field: "start", label: "Start time" },
  { field: "end", label: "End time" },
  { field: "venue", label: "Venue" },
  { field: "summary", label: "Summary" },
  { field: "details", label: "About this event" },
  { field: "img", label: "Image" },
];

export const assertEventIsSound = (event) => {
  assertFormIsCoherent(event.form ?? []);
  assertPublishable(event, EVENT_TO_PUBLISH);
};

export const blogInput = z.object({
  slug: f.slug,
  countries: f.countries,
  status: f.status,

  title: z.string().trim().min(1, "A title is required").max(250),
  /* ⚠ Optional, and no date is invented for a post that has none. */
  date: f.optionalDay,
  programme: f.programme,
  img: f.url,
  excerpt: f.text(600),

  html: z.string().max(500_000, "That post is too long").default("").transform(sanitize),
});

/* ⚠ `img` is NOT here: a post without one falls back to its programme's mark,
   which is a designed state rather than a hole. */
const BLOG_TO_PUBLISH = [
  { field: "date", label: "Date" },
  { field: "excerpt", label: "Excerpt" },
  { field: "html", label: "The post itself" },
];

export const assertBlogIsSound = (blog) => assertPublishable(blog, BLOG_TO_PUBLISH);

export const episodeInput = z.object({
  slug: f.slug,
  countries: f.countries,
  status: f.status,

  title: z.string().trim().min(1, "A title is required").max(200),
  author: f.text(120),
  /* This episode's own write-up. Optional — an episode without one shows the
     show's blurb instead, which is what every episode did before this. */
  description: f.longText(2000),
  programme: f.programme,
  audio: f.url,
  video: f.youtubeUrl,
  /* Seconds, so a card can print a running time without fetching the audio. */
  length: z.union([z.number().int().min(0).max(86_400), z.null()]).default(null),
  cover: f.url,
  order: z.number().int().default(0),
  publishedOn: f.optionalDay,
});

export const showInput = z.object({
  title: f.text(200),
  description: f.longText(2000),
  cover: f.url,
});

/* ⚠ No `.refine()` here: a refined schema is a ZodEffects, which has no
   `.partial()` — exactly what the PATCH path calls. The start-before-end check
   lives in `assertPromoWindow`, on the MERGED document, which is also the only
   way to catch a PATCH moving one end of the window. */
export const promoInput = z.object({
  slug: f.slug,
  countries: f.countries,
  status: f.status,

  name: f.text(120),
  eyebrow: f.text(60),
  heading: f.text(160),
  mark: f.text(160),
  body: f.longText(1000),
  cta: z.object({ label: f.text(60), to: f.text(200) }).default({ label: "", to: "/" }),
  dismiss: f.text(60),

  startsAt: f.optionalDay,
  endsAt: f.optionalDay,
});

/* Two audiences clash unless they are different countries. An EMPTY list means
   everywhere, so a global promo shares its audience with every country one. */
const sameAudience = (a = [], b = []) =>
  a.length === 0 || b.length === 0 || a.some((code) => b.includes(code));

/* Inclusive at both ends, and a missing end is open — a promo with no window
   at all runs from forever until forever, so it overlaps everything. */
const windowsOverlap = (a, b) =>
  (!a.startsAt || !b.endsAt || a.startsAt <= b.endsAt) &&
  (!b.startsAt || !a.endsAt || b.startsAt <= a.endsAt);

const promoRange = ({ startsAt, endsAt }) => {
  if (startsAt && endsAt) return `from ${startsAt} to ${endsAt}`;
  if (startsAt) return `from ${startsAt} onwards`;
  if (endsAt) return `until ${endsAt}`;
  return "with no end date";
};

/* ⚠ `mark`, `eyebrow` and `dismiss` are NOT here — the heading can stand
   alone, and an empty dismiss label deliberately hides that button. `cta` is
   the field name because the CMS edits the label and the link as one control. */
const PROMO_TO_PUBLISH = [
  { field: "heading", label: "Heading" },
  { field: "body", label: "Body" },
  { field: "cta", label: "Button label", read: (p) => p.cta?.label },
];

export const assertPromoWindow = async (promo, req) => {
  assertPublishable(promo, PROMO_TO_PUBLISH);

  const { startsAt, endsAt } = promo;
  if (startsAt && endsAt && startsAt > endsAt) {
    throw badRequest("The promo window ends before it starts", [
      { field: "endsAt", message: "The end date is before the start date" },
    ]);
  }

  /* ⚠ ONE published promo per day, per audience. Overlapping ones left the
     SITE to choose between them by rules invisible from the CMS —
     where both rows say "Published" and only one ever appeared. Refusing the
     save is what makes that badge mean what it says.

     Drafts are deliberately exempt: writing the next campaign while the
     current one runs is the normal way to work, and a draft shows to nobody. */
  if (promo.status !== "published") return;

  /* Read and compared in memory rather than as a Mongo date query: a null end
     means "open", which no range operator expresses, and a site runs tens of
     promos in its life, not thousands. */
  const others = await Promo.find({
    status: "published",
    ...(req?.params?.id ? { _id: { $ne: req.params.id } } : {}),
  })
    .select("name slug countries startsAt endsAt")
    .lean();

  const clash = others.find(
    (other) =>
      sameAudience(promo.countries, other.countries) && windowsOverlap(promo, other)
  );

  if (clash) {
    /* ⚠ No field details on purpose. The admin routes a detail to its field and
       shows a generic toast; this needs to say WHICH promo and WHEN, so it is
       raised as a plain message and reaches the toast and the banner whole. */
    throw badRequest(
      `“${clash.name || clash.slug}” is already published ${promoRange(clash)}. ` +
        `Change these dates, save this one as a draft, or unpublish that one.`
    );
  }
};

/* ⚠ Still called `email` because that is what the sign-in form sends, but it
   accepts either. Validating it as an email here would reject every username
   before the route saw it; the route decides, by looking for an "@". */
export const loginInput = z.object({
  email: z.string().trim().toLowerCase().min(1, "An email or username is required"),
  password: z.string().min(1, "A password is required"),
});

export const userInput = z.object({
  email: z.string().trim().toLowerCase().email("That is not an email address"),
  /* Empty string is normalised away, or several accounts with "" collide on
     the sparse unique index. */
  username: z
    .union([
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9._-]{3,32}$/, "Use 3-32 letters, numbers, . _ or -"),
      z.literal(""),
    ])
    .optional()
    .transform((v) => (v ? v : undefined)),
  name: f.text(120),
  /* 10 rather than 8: there is no second factor behind these accounts. */
  password: z.string().min(10, "Use at least 10 characters"),
  role: z.enum(ROLES).default("editor"),
  countries: f.countries,
  active: z.boolean().default(true),
});

/* An episode is audio or video — exactly one. ⚠ Runs on the MERGED episode, so
   a PATCH setting one is checked against the other rather than against nothing.
   Both errors report on `audio`, which is the field the CMS's media control
   is bound to. */
/* ⚠ `length` and `cover` are NOT here — the card hides a missing running time
   and falls back to the show's artwork. `description` is, because the episode
   page has nothing else to say about the episode. */
const EPISODE_TO_PUBLISH = [{ field: "description", label: "About this episode" }];

export function assertEpisodePlayable(doc) {
  if (!doc.audio && !doc.video) {
    throw badRequest("An episode needs an audio or a video URL", [
      { field: "audio", message: "Fill in an audio URL or a video URL." },
    ]);
  }
  if (doc.audio && doc.video) {
    throw badRequest("An episode is either audio or video, not both", [
      { field: "audio", message: "Clear one of them — an episode plays one way." },
    ]);
  }
  assertPublishable(doc, EPISODE_TO_PUBLISH);
}

export const applyFormInput = z.object({
  kind: z.enum(["volunteer", "career"]),
  name: z.string().trim().min(1, "A name is required").max(120),
  countries: f.countries,
  eyebrow: f.text(80),
  heading: f.text(160),
  mark: f.text(80),
  intro: f.longText(2000),
  formHeading: f.text(120),
  submitLabel: f.text(60),
  subscribeLabel: f.text(200),
  doneHeading: f.text(120),
  doneBody: f.longText(600),
  fields: formInput,
});

export function assertApplyFormIsSound(doc) {
  const fields = doc.fields ?? [];
  assertFormIsCoherent(fields);

  /* ⚠ An EMPTY list is allowed and means "inherit" — a country overriding one
     heading should not have to restate every question. The email rule applies
     only once a form actually asks something. */
  if (fields.length === 0) return;

  if (!fields.some((field) => field.type === "email")) {
    throw badRequest("An application form needs an email question", [
      { field: "fields", message: "Add an Email question — replies depend on it." },
    ]);
  }
}

export const passwordChangeInput = z.object({
  currentPassword: z.string().min(1, "Your current password is required"),
  newPassword: z.string().min(10, "Use at least 10 characters"),
});
