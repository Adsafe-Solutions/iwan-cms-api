import { z } from "zod";
import { COUNTRY_CODES } from "../lib/countries.js";

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

/* The id out of any YouTube URL people actually paste — watch, youtu.be, embed,
   shorts, live, with or without extra query params. Null when it is not one.
   ⚠ Mirrored on the site in src/lib/podcast.js; change both. */
const YOUTUBE = [
  /[?&]v=([A-Za-z0-9_-]{11})/,
  /youtu\.be\/([A-Za-z0-9_-]{11})/,
  /youtube(?:-nocookie)?\.com\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/,
];

export const youtubeId = (value = "") => {
  const text = String(value);
  if (!/^https?:\/\/([\w-]+\.)*(youtube(-nocookie)?\.com|youtu\.be)\//i.test(text)) {
    return null;
  }
  for (const re of YOUTUBE) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
};

/* A YouTube link, or empty. Anything else is refused rather than stored and
   silently failing to embed later. */
export const youtubeUrl = z
  .union([z.string().trim(), z.literal("")])
  .default("")
  .refine((v) => v === "" || Boolean(youtubeId(v)), {
    message: "That is not a YouTube link",
  });

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
