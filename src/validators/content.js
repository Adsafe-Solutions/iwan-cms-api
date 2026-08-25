import { z } from "zod";
import * as f from "./fields.js";
import { badRequest } from "../lib/errors.js";
import { sanitize } from "../lib/html.js";
import {
  formInput,
  assertFormIsCoherent,
  assertFormPresentWhenPublished,
} from "./form.js";

/* The write shapes. Unknown keys are STRIPPED rather than rejected, which is
   what lets the admin PUT a whole record straight back — `id`, `createdAt` and
   friends are simply ignored instead of having to be peeled off first. */

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

  /* The registration form. See validators/form.js — the rules that need to see
     the whole form (duplicate keys, empty choice lists) run in `beforeSave`,
     because a per-field schema cannot check a field against its siblings. */
  form: formInput,
});

/* Both run on the MERGED event, so a PATCH that changes only `status` is still
   checked against the form the event already has. */
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

  /* The post itself, as HTML from the rich-text editor.

     ⚠ Sanitised here as well as by the model's setter. Not belt-and-braces for
     its own sake: sanitising at THIS point means the length cap below is
     measured on what will actually be stored, so a payload padded out with
     100KB of `<script>` cannot slip under the limit and then shrink.

     500KB is far more than any post needs and small enough that a paste-bomb
     cannot fill the collection. */
  html: z.string().max(500_000, "That post is too long").default("").transform(sanitize),
});

export const episodeInput = z.object({
  slug: f.slug,
  countries: f.countries,
  status: f.status,

  title: z.string().trim().min(1, "A title is required").max(200),
  author: f.text(120),
  audio: z.string().trim().url("An audio URL is required"),
  /* Seconds. Kept as data so a listing card can print a running time without
     downloading several MB of audio to measure it. */
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

/* ⚠ A plain object, with no `.refine()` on it. A refined schema is a ZodEffects,
   and ZodEffects has no `.partial()` — which is exactly what the PATCH path
   calls. The start-before-end check therefore lives in `assertPromoWindow`
   below, applied to the MERGED document, which is also the only way it can
   catch a PATCH that moves just one end of the window. */
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

/* ⚠ The field is still called `email` because that is what the sign-in form
   sends, but it now accepts EITHER an email address or a username. Validating
   it as an email here would reject every username before the route ever saw
   it. The route decides which it is, by looking for an "@". */
export const loginInput = z.object({
  email: z.string().trim().toLowerCase().min(1, "An email or username is required"),
  password: z.string().min(1, "A password is required"),
});

export const userInput = z.object({
  email: z.string().trim().toLowerCase().email("That is not an email address"),
  /* Optional. Empty string is normalised away so the sparse unique index sees
     nothing rather than "" — several accounts with "" would collide. */
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
  /* 10 rather than 8: these accounts are never rate-limited by a human typing
     them, and there is no second factor behind them. */
  password: z.string().min(10, "Use at least 10 characters"),
  role: z.enum(["admin", "editor"]).default("editor"),
  countries: f.countries,
  active: z.boolean().default(true),
});

export const passwordChangeInput = z.object({
  currentPassword: z.string().min(1, "Your current password is required"),
  newPassword: z.string().min(10, "Use at least 10 characters"),
});
