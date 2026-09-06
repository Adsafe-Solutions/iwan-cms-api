import mongoose from "mongoose";
import { countriesField, dayField, slugField, statusField } from "./common.js";

/* The on-load promo pop-up.

   ⚠ The one content type whose SHAPE changed on the way into the CMS: the
   site's static promo.js is a single object, this is a collection, so two
   countries can run different campaigns at once. The public endpoint still
   hands the site exactly one promo (or null), so PromoPopup's contract holds.

   `slug` is what the dismissal is keyed on in sessionStorage — a new slug shows
   the campaign to everyone again, with no flag to reset by hand. */
const promoSchema = new mongoose.Schema(
  {
    slug: slugField,
    countries: countriesField,
    status: statusField,

    /* An internal label for the admin list. Never rendered on the site. */
    name: { type: String, trim: true, default: "" },

    eyebrow: { type: String, trim: true, default: "" },

    /* ⚠ Split in two on purpose: `heading` renders plain, `mark` highlighted.
       Where it breaks is an editorial decision, so copy has to be able to
       move it. */
    heading: { type: String, trim: true, default: "" },
    mark: { type: String, trim: true, default: "" },

    body: { type: String, trim: true, default: "" },

    cta: {
      label: { type: String, trim: true, default: "" },
      /* An in-app route, not an absolute URL — the router navigates. */
      to: { type: String, trim: true, default: "/" },
    },

    /* Empty hides the "Maybe later" button entirely. */
    dismiss: { type: String, trim: true, default: "" },

    /* Optional window, inclusive both ends; either end may be omitted.
       ⚠ Compared against the server's UTC day, so a boundary is accurate to
       within a day — fine for a campaign, wrong for anything time-critical. */
    startsAt: dayField(false),
    endsAt: dayField(false),
  },
  { timestamps: true }
);

promoSchema.index({ status: 1, countries: 1 });

export const Promo = mongoose.model("Promo", promoSchema);

export default Promo;
