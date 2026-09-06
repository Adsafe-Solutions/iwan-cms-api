import { badRequest } from "../lib/errors.js";

/* What a record cannot go LIVE without.

   ⚠ Checked on PUBLISH, never on save. A half-written draft is a normal state —
   the CMS is where the writing happens, and refusing the save would throw the
   work away. It is the same shape as the rule that has always governed an
   event's registration form: saveable as a draft, not publishable empty.

   ⚠ The `field` names must match the CMS form's own field names, or the error
   lands on no control and the editor is told to fix something they cannot see.
   `cta` rather than `cta.label` for that reason — the promo edits it as one. */

/* `false` and `0` are real answers; only absence and whitespace are not. */
const isBlank = (value) => {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
};

const list = (labels) =>
  labels.length === 1
    ? labels[0]
    : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;

export function assertPublishable(doc, rules) {
  if (doc?.status !== "published") return;

  const missing = rules.filter(({ field, read }) =>
    isBlank(read ? read(doc) : doc[field])
  );
  if (missing.length === 0) return;

  throw badRequest(
    `Not published: ${list(missing.map((r) => r.label))} ${
      missing.length === 1 ? "is" : "are"
    } needed first. Save it as a draft to keep the work.`,
    missing.map(({ field, message }) => ({
      field,
      message: message ?? "Needed before this can be published",
    }))
  );
}

export default assertPublishable;
