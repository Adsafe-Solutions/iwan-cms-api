import mongoose from "mongoose";
import { countriesField, slugField, statusField } from "./common.js";

/* The show above the episode grid. One show, so `key` is fixed and unique:
   "create if absent, else update" is a single upsert with no way to end up with
   two. Episodes are separate because they are what varies by country. */
const showSchema = new mongoose.Schema(
  {
    key: { type: String, default: "show", unique: true, immutable: true },
    title: { type: String, trim: true, default: "" },
    description: { type: String, trim: true, default: "" },
    cover: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

export const PodcastShow = mongoose.model("PodcastShow", showSchema);

const episodeSchema = new mongoose.Schema(
  {
    slug: slugField,
    countries: countriesField,
    status: statusField,

    title: { type: String, required: [true, "A title is required"], trim: true },
    author: { type: String, trim: true, default: "" },

    /* What THIS episode is about, in the editor's own words.

       ⚠ Not the show's blurb, which lives on the show and describes the
       podcast as a whole. An episode falls back to that one when it has none
       of its own, so this is optional and blank is a real answer. */
    description: { type: String, trim: true, default: "" },

    /* ⚠ Neither is required on its own, but an episode needs ONE of them —
       enforced on the merged document in validators/content.js, since a PATCH
       can clear one without mentioning the other. */
    audio: { type: String, trim: true, default: "" },
    video: { type: String, trim: true, default: "" },

    /* ⚠ SECONDS, kept as data rather than read off the file: the player is
       preload="none", so a card would otherwise fetch several MB to print a
       duration. */
    length: { type: Number, min: 0, default: null },

    /* A nav path — same contract as a blog's or an event's. */
    programme: { type: String, trim: true, default: null },

    /* Cover image. Falls back to the show's artwork. */
    cover: { type: String, trim: true, default: "" },

    /* Ascending; ties break on creation date. */
    order: { type: Number, default: 0 },

    publishedOn: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

episodeSchema.index({ status: 1, countries: 1, order: 1 });

export const PodcastEpisode = mongoose.model("PodcastEpisode", episodeSchema);

export default PodcastEpisode;
