import { z } from "zod";
import { COUNTRY_CODES } from "../lib/countries.js";
import { BLOCK_KINDS } from "../models/Blog.js";

/* Field-level validators shared by every content schema. These sit IN FRONT of
   Mongoose's validation rather than replacing it: Mongoose is the last line and
   also guards the seed, but it reports one generic ValidationError, whereas Zod
   reports every bad field at once — which is what the admin shows inline. */

export const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "A slug is required")
  .max(120, "That slug is too long")
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Use lowercase letters, numbers and single hyphens"
  );

/* ⚠ An EMPTY list means EVERY country, not "no countries". Deduplicated so a
   double-clicked checkbox cannot store ["in", "in"] and make a length check
   lie. */
export const countries = z
  .array(z.enum(COUNTRY_CODES))
  .default([])
  .transform((list) => [...new Set(list)]);

export const status = z.enum(["draft", "published"]).default("draft");

/* "YYYY-MM-DD", or empty. ⚠ Never a Date — see models/common.js. */
export const day = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const optionalDay = z.union([day, z.literal("")]).default("");

export const time = z
  .union([
    z
      .string()
      .trim()
      .regex(/^\d{2}:\d{2}$/, "Use HH:MM"),
    z.literal(""),
  ])
  .default("");

export const text = (max = 400) => z.string().trim().max(max).default("");

export const longText = (max = 8000) => z.string().trim().max(max).default("");

export const url = z
  .union([z.string().trim().url("That is not a valid URL"), z.literal("")])
  .default("");

/* ⚠ A nav PATH like "/iwan-women", or null for "open to the whole community".
   The site resolves it to a label through the active country's nav, so what
   goes in here has to match a `path` in content/base/nav.js. An empty string is
   normalised to null so the two ways of saying "none" cannot both exist. */
export const programme = z
  .union([
    z
      .string()
      .trim()
      .regex(/^\/[a-z0-9/-]*$/i, "Use a nav path like /iwan-women"),
    z.literal(""),
    z.null(),
  ])
  .default(null)
  .transform((v) => (v ? v : null));

export const agendaRow = z.object({
  time: text(20),
  label: text(200),
});

export const bodyBlock = z.object({
  kind: z.enum(BLOCK_KINDS),
  text: longText(4000),
});

/* [lat, lng], or null. Validated as real coordinates rather than any two
   numbers — a transposed pair is a plausible mistake and lands the pin in the
   sea, but an out-of-range one is always a typo. */
export const coords = z
  .union([
    z.tuple([
      z.number().min(-90, "Latitude is -90..90").max(90, "Latitude is -90..90"),
      z.number().min(-180, "Longitude is -180..180").max(180, "Longitude is -180..180"),
    ]),
    z.null(),
  ])
  .default(null);
