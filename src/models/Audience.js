import mongoose from "mongoose";
import { COUNTRY_CODES } from "../lib/countries.js";

/* Everyone who has ever given Iwan their email, from any form on the site.

   ⚠ ONE ROW PER PERSON, keyed on the email. Someone who subscribes, sends a
   message and then registers for an event is one row with three `sources`, not
   three rows — which is the whole reason this exists rather than each form
   keeping its own list.

   It does NOT replace the per-form records. An event registration still has its
   own Registration with that event's answers; a career application still has
   its own Application. This is the person, those are the submissions. */

const SOURCES = ["subscribe", "contact", "event", "volunteer", "career"];

/* A message left on the contact form. Kept on the person rather than in a
   collection of its own so the CMS can show someone's whole history in one
   place, which is what an editor is actually looking for. */
const messageSchema = new mongoose.Schema(
  {
    subject: { type: String, trim: true, default: "" },
    body: { type: String, trim: true, default: "" },
    country: { type: String, enum: COUNTRY_CODES },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const audienceSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },

    /* ⚠ Filled only when blank — see lib/audience.js. A later form can supply a
       name this row does not have, but never overwrite one it does. */
    name: { type: String, trim: true, default: "" },
    mobile: { type: String, trim: true, default: "" },

    /* ⚠ Opt-in, and it never goes back to false on its own. A form submitted
       with the box unticked leaves an existing subscription alone: unticking a
       box on a contact form is not the same act as unsubscribing, and treating
       it as one would quietly drop people. Only an explicit change in the CMS
       clears it. */
    subscribed: { type: Boolean, default: false, index: true },

    /* Every form this person has come through, in first-seen order. */
    sources: { type: [{ type: String, enum: SOURCES }], default: [] },

    /* Where they first arrived from. Not asked — taken from the request. */
    country: { type: String, enum: COUNTRY_CODES },

    messages: { type: [messageSchema], default: [] },

    /* An organiser's private note, same convention as a registration. */
    note: { type: String, trim: true, default: "" },

    /* ⚠ THE WELCOME IS SENT ONCE, EVER. Somebody who subscribes from the
       footer, unsubscribes, and subscribes again should not be greeted twice,
       and somebody who ticks the box on a registration form having already
       subscribed should not be greeted at all — they are already in.

       ⚠ It is CLAIMED before the send, not stamped after: two submissions
       landing together would otherwise both read "not sent yet" and both send.
       A send that then fails clears it again, so the next attempt can try.
       Null means never sent, which is also true of every row predating this. */
    welcomeSentAt: { type: Date, default: null },

    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

audienceSchema.index({ createdAt: -1 });

export const Audience = mongoose.model("Audience", audienceSchema);
export const AUDIENCE_SOURCES = SOURCES;

export default Audience;
