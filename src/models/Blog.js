import mongoose from "mongoose";
import { countriesField, dayField, slugField, statusField } from "./common.js";
import { sanitize } from "../lib/html.js";

export const BLOCK_KINDS = ["h", "p", "li"];

/* ⚠ DEPRECATED — the pre-rich-text body format, kept only so the migration has
   something to read and nothing is destroyed on the way. `html` is the real
   body now; delete this once nothing reads it. */
const blockSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: BLOCK_KINDS, required: true, default: "p" },
    text: { type: String, default: "" },
  },
  { _id: false }
);

const blogSchema = new mongoose.Schema(
  {
    slug: slugField,
    countries: countriesField,
    status: statusField,

    title: { type: String, required: [true, "A title is required"], trim: true },

    /* ⚠ Optional, and no date is invented for a post without one — some
       genuinely carry none. The site sorts those last. */
    date: dayField(false),

    /* A nav path — same contract as an event's. */
    programme: { type: String, trim: true, default: null },

    img: { type: String, trim: true, default: "" },
    excerpt: { type: String, trim: true, default: "" },

    /* ⚠ Sanitised by the setter below, so it is clean IN THE DATABASE rather
       than merely clean when rendered. The route sanitises too; this is the
       line that also covers the seed, the migration and anything scripted,
       since a setter runs on every path a value can arrive by. */
    html: { type: String, default: "", set: sanitize },

    /* ⚠ DEPRECATED — see blockSchema above. No longer edited. */
    body: { type: [blockSchema], default: [] },
  },
  { timestamps: true }
);

blogSchema.index({ status: 1, countries: 1, date: -1 });

export const Blog = mongoose.model("Blog", blogSchema);

export default Blog;
