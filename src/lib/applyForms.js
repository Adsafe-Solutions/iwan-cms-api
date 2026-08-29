import { ApplyForm } from "../models/ApplyForm.js";
import { DEFAULT_APPLY_FORMS } from "./applyDefaults.js";

/* Which form is live, and the rule that keeps that question answerable.

   ⚠ Two forms compete only when they cover the SAME countries. A Canada-only
   form and an everywhere form are not rivals: `resolveApplyForm` below prefers
   the exact country and falls back to the global one, so a Canadian gets the
   Canadian form and everyone else keeps the global one. Treating them as rivals
   was the first thing I got wrong here — activating a Canada form switched the
   page off for India. */
const sameScope = (a = [], b = []) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

/* Turns one form on, and the one it replaces off, in a single step. */
export async function activateApplyForm(doc) {
  const siblings = await ApplyForm.find({
    kind: doc.kind,
    _id: { $ne: doc._id },
    active: true,
  })
    .select("countries")
    .lean();

  const displaced = siblings
    .filter((s) => sameScope(s.countries ?? [], doc.countries ?? []))
    .map((s) => s._id);

  if (displaced.length) {
    await ApplyForm.updateMany({ _id: { $in: displaced } }, { $set: { active: false } });
  }

  await ApplyForm.updateOne({ _id: doc._id }, { $set: { active: true } });
  return displaced.length;
}

/* The form a visitor in this country gets: the active one naming their country
   if there is one, otherwise the active one for everywhere. Deterministic, which
   is what lets a country form and a global form both be live.

   ⚠ Returns null when nothing is active. The page then says it is not taking
   applications rather than inventing a form — what the CMS holds is what the
   site shows, including holding nothing. */
export async function resolveApplyForm(kind, country) {
  const active = await ApplyForm.find({ kind, active: true }).lean();
  if (active.length === 0) return null;

  return (
    active.find((f) => (f.countries ?? []).includes(country)) ??
    active.find((f) => (f.countries ?? []).length === 0) ??
    null
  );
}

/* ⚠ These forms were a singleton per kind before they were a list, and that
   version left a UNIQUE index on `kind` behind. Mongoose does not drop an index
   the schema no longer declares, so it sat there refusing every second form of
   a kind with a duplicate-key error — which is exactly how both defaults
   silently failed to appear.

   Dropped here rather than left as a note in a model file, because a migration
   that depends on someone reading a comment is not a migration — that note was
   written, not read, and both pages sat empty because of it. Named explicitly
   rather than calling `syncIndexes()`, which would also drop indexes somebody
   added on purpose. */
const LEGACY_INDEXES = [
  /* the singleton-per-kind version */
  "kind_1",
  /* the one-per-kind-per-country version that briefly replaced it */
  "kind_1_country_1",
];

async function dropLegacyIndexes() {
  try {
    const existing = await ApplyForm.collection.indexes();
    for (const name of LEGACY_INDEXES) {
      if (!existing.some((i) => i.name === name)) continue;
      try {
        await ApplyForm.collection.dropIndex(name);
        console.log(`[apply-forms] dropped the legacy "${name}" index`);
      } catch (err) {
        console.error(`[apply-forms] could not drop "${name}":`, err.message);
      }
    }
  } catch (err) {
    /* A collection that does not exist yet has no indexes to drop. */
    if (err?.codeName !== "NamespaceNotFound") {
      console.error("[apply-forms] could not check the indexes:", err.message);
    }
  }
}

/* Makes sure each kind has its default form. Called at BOOT — see server.js —
   rather than left to `npm run seed`, because the pages depend on it and
   "someone remembered to run a script" is not a guarantee.

   ⚠ Keyed on the DEFAULT FLAG, not on "this kind has no forms": a deployment
   where an editor already wrote a custom form still gets its default, which is
   the floor the page falls back to.

   ⚠ Written ACTIVE only when nothing else is live, so a restart can never
   switch a page over to the default from whatever an editor had chosen. */
export async function ensureDefaultApplyForms() {
  await dropLegacyIndexes();

  const created = [];

  for (const [kind, form] of Object.entries(DEFAULT_APPLY_FORMS)) {
    /* ⚠ Per kind. One failure must not take the other kind's default with it —
       that is how a single stale index left BOTH pages with nothing. */
    try {
      const existing = await ApplyForm.findOne({ kind, isDefault: true }).lean();
      if (existing) continue;

      const live = await ApplyForm.exists({ kind, active: true });
      await ApplyForm.create({ ...form, isDefault: true, active: !live });
      created.push(kind);
    } catch (err) {
      console.error(`[apply-forms] could not create the ${kind} default:`, err.message);
    }
  }

  return created;
}

export default resolveApplyForm;
