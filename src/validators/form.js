import { z } from "zod";
import { badRequest } from "../lib/errors.js";
import { CHOICE_TYPES, FIELD_TYPES } from "../models/formField.js";

/* The registration form's write shape, plus the three rules that cannot be
   expressed as a per-field schema and have to look at the whole form. */

const optionInput = z.object({
  label: z.string().trim().min(1, "An option needs a label").max(160),
});

export const formFieldInput = z.object({
  key: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "A key is required")
    .max(60)
    .regex(/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/, "Use lowercase words joined by - or _"),
  type: z.enum(FIELD_TYPES),
  label: z.string().trim().min(1, "Every question needs a label").max(300),
  help: z.string().trim().max(300).default(""),
  placeholder: z.string().trim().max(160).default(""),
  required: z.boolean().default(false),
  options: z.array(optionInput).max(60).default([]),
});

/* 60 questions is far more than any event needs and few enough that the form
   still renders as one page. */
export const formInput = z.array(formFieldInput).max(60).default([]);

/* ── the whole-form rules ───────────────────────────────────────────────── */

/* Thrown as one 400 listing every problem at once, keyed by the field's
   position, so the builder can mark each offending row rather than making an
   editor fix one thing, save, and discover the next. */
export function assertFormIsCoherent(form = []) {
  const problems = [];

  const seen = new Map();

  form.forEach((field, i) => {
    const at = `form.${i}`;

    /* ⚠ Duplicate keys are the one error that silently corrupts DATA rather
       than just looking wrong: two questions writing to the same key means one
       answer overwrites the other, and nobody notices until someone reads the
       registrations. */
    if (seen.has(field.key)) {
      problems.push({
        field: `${at}.key`,
        message: `"${field.key}" is already used by "${seen.get(field.key)}"`,
      });
    } else {
      seen.set(field.key, field.label);
    }

    /* A choice question with no options is not a question. */
    if (CHOICE_TYPES.includes(field.type) && field.options.length === 0) {
      problems.push({
        field: `${at}.options`,
        message: `"${field.label}" is a ${field.type} but has no options to choose from`,
      });
    }

    /* Two identically-labelled options are indistinguishable to the person
       answering AND to whoever reads the answers, since the label IS the
       stored value. */
    const labels = field.options.map((o) => o.label.toLowerCase());
    const dupe = labels.find((l, j) => labels.indexOf(l) !== j);
    if (dupe) {
      problems.push({
        field: `${at}.options`,
        message: `"${field.label}" lists "${dupe}" twice`,
      });
    }
  });

  if (problems.length) {
    throw badRequest("The registration form is not finished", problems);
  }
}

/* ⚠ A PUBLISHED event must have somewhere to register. A draft need not — half
   a form is a normal state halfway through writing an event, and refusing to
   save it would throw the work away. The guard is at the point where it starts
   to matter: the moment the event becomes visible to the public. */
export function assertFormPresentWhenPublished(event) {
  if (event.status === "published" && (event.form ?? []).length === 0) {
    throw badRequest("This event has no registration form", [
      {
        field: "form",
        message:
          "Add at least one question before publishing — a live event with nowhere to register is worse than an unpublished one.",
      },
    ]);
  }
}
