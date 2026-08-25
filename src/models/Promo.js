import mongoose from "mongoose";
import { countriesField, dayField, slugField, statusField } from "./common.js";

/* The on-load promo pop-up.

   ⚠ This is the one content type whose SHAPE changed on the way into the CMS.
   The site's content/base/promo.js is a single object, because a static file
   can only describe one campaign at a time. Here it is a collection, so India
   and Canada can run different campaigns at once and a future one can be
   written and scheduled while the current one is still showing. The public
   endpoint still hands the site exactly one promo (or null), so `usePromo()`
   and PromoPopup keep the contract they already have.

   `slug` is what the dismissal is remembered under in sessionStorage. Give a
   new campaign a new slug and everyone sees it once, including people who
   dismissed the last one — there is no flag to reset by hand. */
const promoSchema = new mongoose.Schema(
  {
    slug: slugField,
    countries: countriesField,
    status: statusField,

    /* An internal label for the admin list. Never rendered on the site — the
       visitor-facing words are `heading` / `mark` / `body`. */
    name: { type: String, trim: true, default: "" },

    eyebrow: { type: String, trim: true, default: "" },

    /* ⚠ The heading is split in two on purpose: `heading` renders plain and
       `mark` renders highlighted. Where the line breaks is an editorial
       decision, so it has to stay something copy can move. */
    heading: { type: String, trim: true, default: "" },
    mark: { type: String, trim: true, default: "" },

    body: { type: String, trim: true, default: "" },

    cta: {
      label: { type: String, trim: true, default: "" },
      /* An in-app route ("/events"), not an absolute URL — the popup closes
         itself and the router navigates. */
      to: { type: String, trim: true, default: "/" },
    },

    /* The secondary "Maybe later" text. Empty hides that button entirely. */
    dismiss: { type: String, trim: true, default: "" },

    /* Optional scheduling window, inclusive on both ends. Either may be omitted
       for "from now on" / "until further notice".
       ⚠ Compared against the server's UTC calendar day, so a window boundary is
       accurate to within a day rather than to the visitor's local midnight.
       That is fine for a campaign window and wrong for anything time-critical. */
    startsAt: dayField(false),
    endsAt: dayField(false),

    /* Higher wins when more than one promo is eligible. A country-specific
       promo already beats a global one regardless of this — see routes/promo.js. */
    priority: { type: Number, default: 0 },
  },
  { timestamps: true }
);

promoSchema.index({ status: 1, countries: 1, priority: -1 });

export const Promo = mongoose.model("Promo", promoSchema);

export default Promo;
