import mongoose from "mongoose";
import { countriesField, dayField, slugField, statusField, timeField } from "./common.js";
import { formFieldSchema } from "./formField.js";

/* ⚠ The site renders the agenda as pairs — `[["18:30", "Doors open"], …]`.
   Storing named fields instead is what makes it editable as a two-column form;
   the serialiser turns it back, so the public payload is unchanged. */
const agendaRowSchema = new mongoose.Schema(
  {
    time: { type: String, trim: true, default: "" },
    label: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const eventSchema = new mongoose.Schema(
  {
    slug: slugField,
    countries: countriesField,
    status: statusField,

    title: { type: String, required: [true, "A title is required"], trim: true },
    /* Free text, not an enum — copy rather than something code branches on. */
    kind: { type: String, trim: true, default: "" },

    date: dayField(true),
    start: timeField,
    end: timeField,

    venue: { type: String, trim: true, default: "" },
    /* Used for the map embed when no coords are given. */
    address: { type: String, trim: true, default: "" },
    /* Optional [lat, lng] — pins the exact spot rather than geocoding. */
    coords: {
      type: [Number],
      default: undefined,
      validate: {
        validator: (v) => v == null || v.length === 2,
        message: "coords must be [lat, lng]",
      },
    },

    /* ⚠ A nav PATH ("/iwan-women"), not a label — the site reads the label from
       the active country's nav, so the chip, the filter and the programme page
       cannot disagree. Empty/null means "open to the whole community". */
    programme: { type: String, trim: true, default: null },

    spots: { type: Number, min: 0, default: null },
    img: { type: String, trim: true, default: "" },

    summary: { type: String, trim: true, default: "" },
    details: { type: String, trim: true, default: "" },
    agenda: { type: [agendaRowSchema], default: [] },

    /* ⚠ An event may not be PUBLISHED with an empty form (see routes/admin.js),
       though it can be SAVED as a draft without one — half a form is a normal
       state to be in, and refusing the save would throw the work away. Ordered:
       this is the order the questions appear in. */
    form: { type: [formFieldSchema], default: [] },
  },
  { timestamps: true }
);

/* The two queries this collection actually serves. */
eventSchema.index({ status: 1, countries: 1, date: 1 });

export const Event = mongoose.model("Event", eventSchema);

export default Event;
