import mongoose from "mongoose";
import { COUNTRY_CODES } from "../lib/countries.js";
import { FIELD_TYPES } from "./formField.js";

/* Somebody signing up for an event.

   ⚠ THE ANSWER SNAPSHOTS ITS OWN QUESTION. Each answer stores the `label` and
   `type` of the question as it was WHEN IT WAS ANSWERED, not just the key.

   That is the single most important decision in this file. A registration is a
   historical record: someone answered a specific question on a specific day. The
   form is editable — an editor can rename "Do you have a licence?" to something
   else next week, change its type, or delete it entirely. If answers stored only
   the key and the CMS looked the question up in the current form to display it,
   then every edit would silently rewrite history, and deleting a question would
   make its answers unreadable. Storing the question with the answer costs a few
   bytes and means a registration can always be read exactly as it was given. */
const answerSchema = new mongoose.Schema(
  {
    /* Matches a `key` in the event's form at the time of submission. */
    key: { type: String, required: true, trim: true },

    /* The question, as it was asked. */
    label: { type: String, required: true, trim: true },
    type: { type: String, enum: FIELD_TYPES, required: true },

    /* The answer. Mixed because the shape follows the type:
         text/email/phone/date/textarea → String
         number                         → Number
         name                           → { first, last }
         radio/select                   → String  (the option's label)
         checkboxes                     → [String]
         consent                        → Boolean
       Validated against the question's type on the way in — see
       validators/registration.js — so this is loose here and strict there. */
    value: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const registrationSchema = new mongoose.Schema(
  {
    /* Both the id and the slug. The id is the real link; the slug is kept
       alongside so the admin can list and filter registrations without a join,
       and so a registration is still legible if its event is ever deleted. */
    event: { type: mongoose.Schema.Types.ObjectId, ref: "Event", required: true },
    eventSlug: { type: String, required: true, trim: true, index: true },
    /* The event's title as it was — same reasoning as the answer labels. */
    eventTitle: { type: String, trim: true, default: "" },

    /* Which country's site this came from. Not asked — taken from the request,
       so a Canadian sign-up is filed as Canadian without anyone choosing. */
    country: { type: String, enum: COUNTRY_CODES, required: true },

    answers: { type: [answerSchema], default: [] },

    /* ⚠ Pulled OUT of the answers for the list view and for searching. These
       are copies, not the source — the answers array remains authoritative. A
       form with no name or email question simply leaves them blank rather than
       forcing every event to ask. */
    name: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, lowercase: true, default: "" },

    status: {
      type: String,
      enum: ["new", "confirmed", "waitlist", "cancelled"],
      default: "new",
      index: true,
    },

    /* An organiser's private note — "called, coming with two kids". Never shown
       to the person who registered. */
    note: { type: String, trim: true, default: "" },

    /* ⚠ Written only on a CONFIRMED SEND, never on an attempt. The whole value
       of this field to an organiser is answering "did this person actually get
       their email?", and a timestamp that also recorded failures would answer a
       different question while looking like it answered that one.

       Stamped by the public sign-up route as well as by the admin's resend, so
       a registration that has never been touched by hand still reads correctly
       rather than claiming nothing was ever sent. Anyone who registered before
       this field existed has no stamp and is shown as unknown — which is the
       honest answer, not "never sent". */
    confirmationSentAt: { type: Date, default: null },
    confirmationSentCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/* The two queries the admin actually runs: everything for one event, newest
   first, and everything across events filtered by status. */
registrationSchema.index({ eventSlug: 1, createdAt: -1 });
registrationSchema.index({ createdAt: -1 });

export const Registration = mongoose.model("Registration", registrationSchema);

export default Registration;
