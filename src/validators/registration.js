import { badRequest } from "../lib/errors.js";

/* Turns whatever the browser posted into answers that can be stored, checked
   question by question against the event's CURRENT form.

   ⚠ This is the security boundary for the one endpoint the public can write
   to. Nothing here trusts the submitted shape: the FORM decides which keys
   exist, what type each is, and which options are allowed. A key that is not in
   the form is dropped rather than stored, so a crafted request cannot invent
   fields, and a choice answer that is not one of the offered options is
   refused rather than saved as free text. */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* Long enough for a real answer to an open question, short enough that a bot
   cannot fill the collection one submission at a time. */
const MAX_TEXT = 2000;
const MAX_SHORT = 300;

const str = (v) => (typeof v === "string" ? v.trim() : "");

/* Whether an answer counts as given. ⚠ `false` and `0` are real answers, so a
   plain falsy check would treat "no" and "zero" as blank. */
const isBlank = (value) => {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    return Object.values(value).every((v) => str(v) === "");
  }
  return false;
};

function coerce(field, raw, fail) {
  const options = (field.options ?? []).map((o) => o.label);

  switch (field.type) {
    case "name": {
      const first = str(raw?.first).slice(0, MAX_SHORT);
      const last = str(raw?.last).slice(0, MAX_SHORT);
      return first || last ? { first, last } : null;
    }

    case "email": {
      const value = str(raw).slice(0, MAX_SHORT).toLowerCase();
      if (!value) return null;
      if (!EMAIL.test(value)) fail("That does not look like an email address");
      return value;
    }

    case "number": {
      if (raw === "" || raw === null || raw === undefined) return null;
      const n = Number(raw);
      if (!Number.isFinite(n)) fail("That is not a number");
      return n;
    }

    case "date": {
      const value = str(raw);
      if (!value) return null;
      /* Same "YYYY-MM-DD string, never a Date" rule the rest of this API
         follows — see models/common.js. */
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail("Use YYYY-MM-DD");
      return value;
    }

    case "consent": {
      /* Only an explicit tick counts. */
      return raw === true || raw === "true" || raw === "on";
    }

    case "radio":
    case "select": {
      const value = str(raw);
      if (!value) return null;
      /* ⚠ Must be one of the options offered. Otherwise the endpoint accepts
         arbitrary text under a question that looks like a controlled choice,
         and whoever reads the answers later has no idea. */
      if (!options.includes(value)) fail(`"${value}" is not one of the choices`);
      return value;
    }

    case "checkboxes": {
      const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
      const picked = [...new Set(list.map(str).filter(Boolean))];
      const unknown = picked.filter((p) => !options.includes(p));
      if (unknown.length) fail(`"${unknown[0]}" is not one of the choices`);
      return picked;
    }

    case "textarea":
      return str(raw).slice(0, MAX_TEXT) || null;

    default:
      /* text, phone, and anything else that is a line of text. */
      return str(raw).slice(0, MAX_SHORT) || null;
  }
}

/* `form` is the event's questions; `submitted` is the raw `{ key: value }` the
   browser posted. Returns the answers ready to store.

   Every problem is collected and thrown as one 400, so a person filling in a
   form is told everything that is wrong at once rather than one field at a
   time. */
export function buildAnswers(form = [], submitted = {}) {
  const problems = [];
  const answers = [];

  for (const field of form) {
    const fail = (message) => problems.push({ field: field.key, message });
    const raw = submitted?.[field.key];

    let value = null;
    try {
      value = coerce(field, raw, fail);
    } catch {
      fail("That answer could not be read");
    }

    /* ⚠ A consent question is required whatever its `required` flag says — an
       agreement nobody has to give is not an agreement, which is the same rule
       the builder enforces by hiding the toggle. */
    const mustHave = field.required || field.type === "consent";

    if (mustHave) {
      if (field.type === "consent" && value !== true) {
        fail("This has to be ticked to continue");
      } else if (field.type !== "consent" && isBlank(value)) {
        fail("This one is required");
      }
    }

    answers.push({
      key: field.key,
      /* ⚠ Snapshotted, so the answer stays readable after the question is
         renamed or deleted — see models/Registration.js. */
      label: field.label,
      type: field.type,
      value,
    });
  }

  if (problems.length) {
    throw badRequest("Some answers need fixing", problems);
  }

  return answers;
}

/* The name and email lifted out for the list view. Best-effort: a form that
   asks for neither simply leaves them blank rather than every event being
   forced to ask. */
export function summarise(answers = []) {
  const nameField = answers.find((a) => a.type === "name" && a.value);
  const name = nameField
    ? [nameField.value.first, nameField.value.last].filter(Boolean).join(" ")
    : (answers.find((a) => /name/i.test(a.label) && typeof a.value === "string")?.value ??
      "");

  const email = answers.find((a) => a.type === "email" && a.value)?.value ?? "";

  return { name: name.slice(0, 200), email };
}
