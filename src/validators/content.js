import { z } from "zod";
import { ROLES } from "../models/User.js";
import * as f from "./fields.js";
import { badRequest } from "../lib/errors.js";
import { sanitize } from "../lib/html.js";
import {
  formInput,
  assertFormIsCoherent,
  assertFormPresentWhenPublished,
} from "./form.js";

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
export const assertEventIsSound = (event) => {
  assertFormIsCoherent(event.form ?? []);
  assertFormPresentWhenPublished(event);
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

  /* ⚠ Sanitised here as well as by the model's setter, and not for its own
     sake: doing it HERE means the length cap is measured on what will actually
     be stored, so a payload padded with 100KB of `<script>` cannot slip under
     the limit and then shrink. */
  html: z.string().max(500_000, "That post is too long").default("").transform(sanitize),
});

export const episodeInput = z.object({
  slug: f.slug,
  countries: f.countries,
  status: f.status,

  title: z.string().trim().min(1, "A title is required").max(200),
  author: f.text(120),
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
  priority: z.number().int().default(0),
});

export const assertPromoWindow = ({ startsAt, endsAt }) => {
  if (startsAt && endsAt && startsAt > endsAt) {
    throw badRequest("The promo window ends before it starts", [
      { field: "endsAt", message: "The end date is before the start date" },
    ]);
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
}

export const passwordChangeInput = z.object({
  currentPassword: z.string().min(1, "Your current password is required"),
  newPassword: z.string().min(10, "Use at least 10 characters"),
});
