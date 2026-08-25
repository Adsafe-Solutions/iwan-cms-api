import mongoose from "mongoose";
import { countriesField, slugField, statusField } from "./common.js";

/* The show itself — the title, blurb and artwork above the episode grid.

   There is one show, so this is a singleton: `key` is fixed and unique, which
   means "create if absent, otherwise update" is a single upsert and there is no
   way to end up with two competing show records. Episodes are a separate
   collection because they are what varies by country. */
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
    /* Shown as "by {author}" under the player. */
    author: { type: String, trim: true, default: "" },

    /* A direct URL to the audio file. The site's AudioPlayer wraps a native
       <audio> pointed straight at it. */
    audio: {
      type: String,
      required: [true, "An audio URL is required"],
      trim: true,
    },

    /* ⚠ Running time in SECONDS, kept as data rather than read off the file.
       The player carries preload="none" precisely so it downloads nothing until
       someone presses play; without this number the card would have to fetch
       several MB just to print a duration. */
    length: { type: Number, min: 0, default: null },

    /* Optional per-episode artwork. Falls back to the show's cover. */
    cover: { type: String, trim: true, default: "" },

    /* Ascending display order within the grid; ties break on creation date. */
    order: { type: Number, default: 0 },

    publishedOn: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

episodeSchema.index({ status: 1, countries: 1, order: 1 });

export const PodcastEpisode = mongoose.model("PodcastEpisode", episodeSchema);

export default PodcastEpisode;
