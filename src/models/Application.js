import mongoose from "mongoose";
import { COUNTRY_CODES } from "../lib/countries.js";
import { FIELD_TYPES } from "./formField.js";

/* Someone applying to volunteer or to work at Iwan.

   Separate from Audience because an application is a submission with its own
   life — it gets read, replied to and closed — while the audience row is just
   the person. The two are linked by email; the audience row is written at the
   same time so an applicant is reachable from the one list. */

const KINDS = ["volunteer", "career"];

/* Same shape as a registration's answers, and for the same reason: the question
   is stored with the answer, so editing the form later cannot rewrite what
   somebody said. */
const answerSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    type: { type: String, enum: FIELD_TYPES, required: true },
    value: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const applicationSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: KINDS, required: true, index: true },

    /* Copies, so the list reads without a join. `audience` is the link. */
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    name: { type: String, trim: true, default: "" },
    mobile: { type: String, trim: true, default: "" },

    audience: { type: mongoose.Schema.Types.ObjectId, ref: "Audience" },

    /* What they are applying for, as free text — a role people type rather than
       a list this service has to keep in step with a careers page. */
    role: { type: String, trim: true, default: "" },

    answers: { type: [answerSchema], default: [] },

    country: { type: String, enum: COUNTRY_CODES, required: true },

    status: {
      type: String,
      enum: ["new", "reviewing", "accepted", "declined"],
      default: "new",
      index: true,
    },

    note: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

applicationSchema.index({ kind: 1, createdAt: -1 });
applicationSchema.index({ createdAt: -1 });

export const Application = mongoose.model("Application", applicationSchema);
export const APPLICATION_KINDS = KINDS;

export default Application;
