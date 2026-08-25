import mongoose from "mongoose";
import { countriesField, dayField, slugField, statusField } from "./common.js";
import { sanitize } from "../lib/html.js";

export const BLOCK_KINDS = ["h", "p", "li"];

/* ⚠ DEPRECATED — the pre-rich-text body format.

   Posts used to be `[["h", "…"], ["p", "…"], ["li", "…"]]`, which was as much
   structure as the transcribed source pages carried. `html` below is the real
   body now. This stays on the model only so the migration has something to read
   and so nothing is destroyed on the way; delete it, and the `body` key in the
   public payload, once the site renders `html`. */
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

    /* ⚠ Optional, and no date is ever invented for a post that has none — two
       of the transcribed posts genuinely carry no date on the live site. The
       site sorts undated posts last and renders them without a date line. */
    date: dayField(false),

    /* A nav path, same contract as an event's — see Event.js. */
    programme: { type: String, trim: true, default: null },

    img: { type: String, trim: true, default: "" },
    excerpt: { type: String, trim: true, default: "" },

    /* The post, as HTML from the rich-text editor.

       ⚠ Sanitised by the setter below, so it is clean in the database rather
       than merely clean when rendered. The setter is the last line of defence —
       the write route sanitises too — and it is the one thing that also covers
       the seed, the migration and anything written from a script. A setter runs
       on `create`, on `doc.set()` and on `findOneAndUpdate`'s `$set`, which is
       every path a value can reach this field by. */
    html: { type: String, default: "", set: sanitize },

    /* ⚠ DEPRECATED — see blockSchema above. Derived from `html` on the way out;
       no longer edited. */
    body: { type: [blockSchema], default: [] },
  },
  { timestamps: true }
);

blogSchema.index({ status: 1, countries: 1, date: -1 });

export const Blog = mongoose.model("Blog", blogSchema);

export default Blog;
