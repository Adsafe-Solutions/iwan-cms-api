import { COUNTRY_CODES } from "../lib/countries.js";

/* Field definitions shared by every content model, so "how a slug is spelled"
   or "what statuses exist" is decided once. */

export const STATUSES = ["draft", "published"];

/* The slug is the public identity of a document — /events/<slug>,
   /blogs/<slug>, and the sessionStorage key a dismissed promo is remembered
   under. It is serialised to the site as `id`, which is the field name the
   existing content files use. */
export const slugField = {
  type: String,
  required: [true, "A slug is required"],
  unique: true,
  trim: true,
  lowercase: true,
  match: [/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase words joined by -"],
};

/* An EMPTY list means every country — see lib/countries.js. Anything else is a
   subset of the codes the public site knows about. */
export const countriesField = {
  type: [{ type: String, enum: COUNTRY_CODES, lowercase: true, trim: true }],
  default: [],
};

export const statusField = {
  type: String,
  enum: STATUSES,
  default: "draft",
  index: true,
};

/* ⚠ Dates are stored as plain "YYYY-MM-DD" STRINGS, not as Date objects, and
   that is deliberate. The site parses them field-by-field (`parse()` in
   src/lib/events.js) precisely because `new Date("2026-08-21")` is read as UTC
   and lands a day early for anyone west of Greenwich. A Date here would be
   serialised back through an ISO timestamp and reintroduce exactly that bug.
   An event happens on a calendar day in its own place; it is not an instant. */
export const dayField = (required = false) => ({
  type: String,
  required,
  trim: true,
  match: [/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"],
});

export const timeField = {
  type: String,
  trim: true,
  match: [/^\d{2}:\d{2}$/, "Time must be HH:MM"],
};
