import mongoose from "mongoose";
import { COUNTRY_CODES } from "../lib/countries.js";
import { FIELD_TYPES } from "./formField.js";

/* Somebody signing up for an event.

   ⚠ THE ANSWER SNAPSHOTS ITS OWN QUESTION — each answer stores the `label` and
   `type` as they were when answered, not just the key. The form is editable, so
   looking the question up in the CURRENT form would silently rewrite history on
   every edit and make a deleted question's answers unreadable. */
const answerSchema = new mongoose.Schema(
  {
    /* Matches a `key` in the form as it was at submission. */
    key: { type: String, required: true, trim: true },

    label: { type: String, required: true, trim: true },
    type: { type: String, enum: FIELD_TYPES, required: true },

    /* Mixed because the shape follows the type: String for most, Number for
       number, { first, last } for name, [String] for checkboxes, Boolean for
       consent. Loose here, strict in validators/registration.js. */
    value: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const registrationSchema = new mongoose.Schema(
  {
    /* The id is the real link; the slug is kept alongside so the admin can
       filter without a join, and so this stays legible if the event is
       deleted. */
    event: { type: mongoose.Schema.Types.ObjectId, ref: "Event", required: true },
    eventSlug: { type: String, required: true, trim: true, index: true },
    /* As it was — same reasoning as the answer labels. */
    eventTitle: { type: String, trim: true, default: "" },

    /* Taken from the request, not asked, so a Canadian sign-up files itself. */
    country: { type: String, enum: COUNTRY_CODES, required: true },

    answers: { type: [answerSchema], default: [] },

    /* ⚠ Copies pulled out of the answers for listing and searching — `answers`
       stays authoritative. A form that asks for neither leaves them blank. */
    name: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, lowercase: true, default: "" },

    status: {
      type: String,
      enum: ["new", "confirmed", "waitlist", "cancelled"],
      default: "new",
      index: true,
    },

    /* The site-wide photography checkbox, sent BESIDE the answers like
       `subscribe` — not one of them, so no event's form has to carry it.
       ⚠ Null means NO RECORD (rows predating the field), never "declined". */
    photoConsent: { type: Boolean, default: null },

    /* An organiser's private note. Never shown to the registrant. */
    note: { type: String, trim: true, default: "" },

    /* ⚠ Written only on a CONFIRMED SEND, never on an attempt — a stamp that
       also recorded failures would look like a record of deliveries while
       answering a different question. Stamped by the public sign-up route as
       well as the admin's resend. No stamp means UNKNOWN, not "never sent":
       registrations predating this field have none. */
    confirmationSentAt: { type: Date, default: null },
    confirmationSentCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/* The two queries the admin actually runs. */
registrationSchema.index({ eventSlug: 1, createdAt: -1 });
registrationSchema.index({ createdAt: -1 });

export const Registration = mongoose.model("Registration", registrationSchema);

export default Registration;
