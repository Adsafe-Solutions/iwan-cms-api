import { badRequest } from "../lib/errors.js";

/* Turns what the browser posted into storable answers, checked against the
   event's CURRENT form.

   ⚠ The security boundary for the one endpoint the public can write to. The
   FORM decides which keys exist, their types and their allowed options: an
   unknown key is dropped rather than stored, and an off-list choice is refused
   rather than saved as free text. */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* Long enough for a real answer, short enough to bound a bot's submission. */
const MAX_TEXT = 2000;
const MAX_SHORT = 300;

const str = (v) => (typeof v === "string" ? v.trim() : "");

/* ⚠ `false` and `0` are real answers — a falsy check would call them blank. */
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
      /* "YYYY-MM-DD string, never a Date" — see models/common.js. */
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
      /* ⚠ Must be one of the offered options, or the endpoint accepts free
         text under a question that reads as a controlled choice. */
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
      /* text, phone, and anything else that is one line. */
      return str(raw).slice(0, MAX_SHORT) || null;
  }
}

/* `form` is the questions, `submitted` the raw `{ key: value }` posted. Every
   problem is collected into one 400, so the person is told everything that is
   wrong at once rather than one field at a time. */
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

    /* ⚠ Consent is required whatever its `required` flag says — an agreement
       nobody has to give is not an agreement. */
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
      /* ⚠ Snapshotted — see models/Registration.js. */
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

/* Lifted out for the list view. Best-effort: a form asking for neither leaves
   them blank rather than forcing every event to ask. */
export function summarise(answers = []) {
  const nameField = answers.find((a) => a.type === "name" && a.value);
  const name = nameField
    ? [nameField.value.first, nameField.value.last].filter(Boolean).join(" ")
    : (answers.find((a) => /name/i.test(a.label) && typeof a.value === "string")?.value ??
      "");

  const email = answers.find((a) => a.type === "email" && a.value)?.value ?? "";

  return { name: name.slice(0, 200), email };
}
