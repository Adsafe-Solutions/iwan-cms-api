import mongoose from "mongoose";

/* A registration form is an ordered list of these, living on the event rather
   than in a collection of its own.

   ⚠ `key` is the contract with future SUBMISSIONS: answers are stored against
   it, so renaming a label must not change it or every answer already collected
   becomes unattributable. The admin generates it once, then locks it. */

export const FIELD_TYPES = [
  "text",
  "textarea",
  /* ⚠ a COMPOSITE: two boxes, two stored values, one question. Splitting it in
     the builder would let an editor ask for a last name and not a first. */
  "name",
  "email",
  "phone",
  "number",
  "date",
  "radio",
  "checkboxes",
  "select",
  /* ⚠ MUST be ticked to submit, whatever `required` says. Distinct from a
     one-option checkboxes field, which can be left blank. */
  "consent",
];

/* The types whose meaning comes from a list of options. A radio with none is
   not a question but a bug, and the validator refuses it. */
export const CHOICE_TYPES = ["radio", "checkboxes", "select"];

const optionSchema = new mongoose.Schema(
  {
    /* Stored as the answer too — a separate `value` would be a second
       identifier to keep in step for no gain at this size. */
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

    label: { type: String, required: [true, "Every field needs a label"], trim: true },

    help: { type: String, trim: true, default: "" },

    /* Ignored by the types that have no box. */
    placeholder: { type: String, trim: true, default: "" },

    required: { type: Boolean, default: false },

    options: { type: [optionSchema], default: [] },
  },
  { _id: false }
);

export default formFieldSchema;
