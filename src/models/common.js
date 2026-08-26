import { COUNTRY_CODES } from "../lib/countries.js";

/* Field definitions shared by every content model, decided once. */

export const STATUSES = ["draft", "published"];

/* The public identity of a document — /events/<slug> — serialised to the site
   as `id`, which is what the existing content files call it. */
export const slugField = {
  type: String,
  required: [true, "A slug is required"],
  unique: true,
  trim: true,
  lowercase: true,
  match: [/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase words joined by -"],
};

/* ⚠ An EMPTY list means every country — see lib/countries.js. */
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

/* ⚠ Plain "YYYY-MM-DD" STRINGS, never Date objects. `new Date("2026-08-21")`
   is read as UTC and lands a day early west of Greenwich; a Date here would be
   serialised through an ISO timestamp and reintroduce that. An event happens on
   a calendar day, not at an instant. */
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
