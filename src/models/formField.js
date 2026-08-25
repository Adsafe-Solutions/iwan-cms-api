import mongoose from "mongoose";

/* A registration form is an ordered list of these. It lives on the event
   (Event.form) rather than in a collection of its own: a form belongs to
   exactly one event, is edited with it, and is meaningless without it.

   ⚠ `key` is the contract with future SUBMISSIONS. An answer will be stored
   against the key, so renaming a label must not change it — otherwise every
   answer already collected becomes unattributable. The admin generates it from
   the label once, then locks it behind a deliberate edit, the same way the slug
   field works. */

export const FIELD_TYPES = [
  /* one line of text */
  "text",
  /* several lines — dietary requirements, questions, anything open */
  "textarea",
  /* ⚠ a COMPOSITE: renders as two boxes (first / last) and stores two values.
     Kept as one field because "your name" is one question to the person
     answering, and splitting it in the builder would let an editor accidentally
     ask for a last name and not a first. */
  "name",
  "email",
  "phone",
  "number",
  "date",
  /* pick exactly one, shown as radios */
  "radio",
  /* pick any number, shown as tick boxes */
  "checkboxes",
  /* pick exactly one, shown as a dropdown — for long lists where radios would
     take over the page */
  "select",
  /* ⚠ a single tick box that MUST be ticked to submit, whatever `required`
     says — "I agree to the safety rules". Distinct from a one-option
     checkboxes field, which can be left blank. */
  "consent",
];

/* The types whose meaning comes from a list of options. A radio with no options
   is not a question, it is a bug — the validator refuses it. */
export const CHOICE_TYPES = ["radio", "checkboxes", "select"];

const optionSchema = new mongoose.Schema(
  {
    /* What the person sees. Stored as the answer too — an option's own `value`
       would be a second identifier to keep in step for no gain at this size. */
    label: { type: String, required: true, trim: true },
  },
  { _id: false }
);

export const formFieldSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: [true, "Every field needs a key"],
      trim: true,
      lowercase: true,
      match: [/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/, "Use lowercase words joined by - or _"],
    },
    type: { type: String, enum: FIELD_TYPES, required: true },

    /* The question itself. */
    label: { type: String, required: [true, "Every field needs a label"], trim: true },

    /* The small grey line underneath — "example@example.com", "First Name". */
    help: { type: String, trim: true, default: "" },

    /* Greyed text inside the box. Ignored by the types that have no box. */
    placeholder: { type: String, trim: true, default: "" },

    required: { type: Boolean, default: false },

    options: { type: [optionSchema], default: [] },
  },
  { _id: false }
);

export default formFieldSchema;
