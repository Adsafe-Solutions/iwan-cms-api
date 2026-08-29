import mongoose from "mongoose";
import formFieldSchema from "./formField.js";
import { APPLICATION_KINDS } from "./Application.js";
import { countriesField } from "./common.js";

/* A volunteer or career form: its words and its questions, built in the CMS.

   ⚠ A LIST, not a singleton. An editor writes as many as they like — a draft
   for next season, last year's, a Canada-only variant — and turns ONE of them
   on. `active` is what the site reads; everything else is kept, not deleted.

   ⚠ ONE ACTIVE PER KIND PER COUNTRY. Activating deactivates any other form of
   the same kind whose countries overlap, so "which form is live in Canada"
   always has exactly one answer. An empty `countries` means everywhere, so it
   overlaps with all of them — see lib/applyForms.js, which owns that rule. */
const applyFormSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: APPLICATION_KINDS, required: true, index: true },

    /* An editor's own label for the list — never shown on the site. */
    name: {
      type: String,
      required: [true, "A name is required"],
      trim: true,
      maxlength: 120,
    },

    countries: countriesField,

    active: { type: Boolean, default: false, index: true },

    /* ⚠ The one form per kind that is always there. It can be edited and it can
       be turned OFF, but it cannot be deleted — so there is always something to
       fall back on when no custom form is live. `immutable` because nothing in
       a request should be able to promote or demote a form; the seed is the
       only thing that sets it. */
    isDefault: { type: Boolean, default: false, immutable: true },

    /* The page's own words. ⚠ Not optional in spirit: what the CMS holds is
       what the site renders, so an empty heading is an empty heading on the
       page. The seed writes the site's current copy in, so a fresh database
       starts with forms that read exactly as the pages already do. */
    eyebrow: { type: String, trim: true, default: "" },
    heading: { type: String, trim: true, default: "" },
    /* The highlighted tail of the heading, split from it because where a
       headline breaks is an editorial decision. */
    mark: { type: String, trim: true, default: "" },
    intro: { type: String, trim: true, default: "" },

    formHeading: { type: String, trim: true, default: "" },
    submitLabel: { type: String, trim: true, default: "" },
    subscribeLabel: { type: String, trim: true, default: "" },
    doneHeading: { type: String, trim: true, default: "" },
    doneBody: { type: String, trim: true, default: "" },

    /* Ordered: this is the order the questions appear in. */
    fields: { type: [formFieldSchema], default: [] },
  },
  { timestamps: true }
);

applyFormSchema.index({ kind: 1, active: 1 });
applyFormSchema.index({ kind: 1, updatedAt: -1 });

export const ApplyForm = mongoose.model("ApplyForm", applyFormSchema);

export default ApplyForm;
