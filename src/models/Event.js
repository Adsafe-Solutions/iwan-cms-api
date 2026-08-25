import mongoose from "mongoose";
import { countriesField, dayField, slugField, statusField, timeField } from "./common.js";
import { formFieldSchema } from "./formField.js";

/* One row of the running order on an event's detail page.

   ⚠ The site renders the agenda as `[["18:30", "Doors open"], …]` — an array of
   pairs. Storing it as named fields instead is what makes it editable as a
   sane two-column form in the admin; the serialiser turns it back into pairs,
   so the public payload is byte-identical to today's static file. */
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
    /* A short label like "Community meal" or "Volunteering" — free text, not an
       enum, because it is copy rather than a category anything branches on. */
    kind: { type: String, trim: true, default: "" },

    date: dayField(true),
    start: timeField,
    end: timeField,

    venue: { type: String, trim: true, default: "" },
    /* The postal address, used for the map embed when no coords are given. */
    address: { type: String, trim: true, default: "" },
    /* Optional [lat, lng]. When present the site uses OpenStreetMap's keyless
       embed and pins the exact spot instead of geocoding the address text. */
    coords: {
      type: [Number],
      default: undefined,
      validate: {
        validator: (v) => v == null || v.length === 2,
        message: "coords must be [lat, lng]",
      },
    },

    /* ⚠ A nav PATH ("/iwan-women"), not a label. The site reads the label back
       out of the active country's nav, which is what stops the chip, the filter
       and the programme page from disagreeing — and why an event pointing at a
       programme a country does not run degrades gracefully instead of breaking.
       Empty string / null means "open to the whole community". */
    programme: { type: String, trim: true, default: null },

    spots: { type: Number, min: 0, default: null },
    img: { type: String, trim: true, default: "" },

    summary: { type: String, trim: true, default: "" },
    details: { type: String, trim: true, default: "" },
    agenda: { type: [agendaRowSchema], default: [] },

    /* The registration form people fill in to come to this event.

       ⚠ An event may not be PUBLISHED with an empty form — see the guard in
       routes/admin.js. It can be saved as a draft without one, because half a
       form is a normal state to be in halfway through writing an event, and
       refusing the save would throw away the work. What must never happen is a
       LIVE event with nowhere to register.

       Ordered: this is the order the questions appear in. */
    form: { type: [formFieldSchema], default: [] },
  },
  { timestamps: true }
);

/* The two queries this collection actually serves: the public list (published,
   for one country, in date order) and the admin list (everything, newest edit
   first). */
eventSchema.index({ status: 1, countries: 1, date: 1 });

export const Event = mongoose.model("Event", eventSchema);

export default Event;
