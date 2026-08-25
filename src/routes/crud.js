import { Router } from "express";
import { notFound, wrap } from "../lib/errors.js";
import { validate } from "../middleware/validate.js";
import { assertCountryScope } from "../middleware/auth.js";
import { isCountryCode } from "../lib/countries.js";

/* Events, blogs, episodes and promos differ in their fields and in nothing
   else: same identity (a unique slug), same country list, same draft/published
   switch, same six operations. This builds that router once, so a fifth content
   type is a model, a Zod schema, a serialiser and one line in routes/index.js.

   Anything a type does NOT share goes in `beforeSave` rather than being smuggled
   into the factory as another flag. */

const STATUSES = ["draft", "published"];

/* The filter value meaning "not tied to any programme". A sentinel rather than
   an empty string, because an empty query value cannot be told apart from an
   absent one. The admin sends the same constant.
   ⚠ It starts with "__" so it can never collide with a real nav path, which
   always starts with "/". */
export const NO_PROGRAMME = "__none";

/* A user-typed search string goes into a RegExp, so every character that means
   something to the engine has to stop meaning it — otherwise a lone "(" is a
   500 and ".*" walks the whole collection. */
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const MAX_LIMIT = 200;

export function crudRouter({
  model,
  schema,
  serialize,
  sort = { updatedAt: -1 },
  /* Fields a `?q=` search looks in. */
  searchFields = ["title", "slug"],
  /* Runs on the finished document before it is saved, for a rule the shared
     schema cannot express — see promos and their start/end window. */
  beforeSave,
}) {
  const router = Router();

  /* Which documents this account is allowed to SEE.

     An unscoped account (any admin, or an editor with no countries) sees
     everything. A scoped editor sees only documents naming one of their own
     countries — which deliberately hides global documents from them too, since
     `assertCountryScope` would refuse the edit anyway and a list full of rows
     that cannot be opened is worse than a shorter list. */
  const visibleTo = (user) =>
    user.role === "admin" || !user.countries?.length
      ? {}
      : { countries: { $in: user.countries } };

  /* GET / — the admin listing. Drafts included; that is the whole point. */
  router.get(
    "/",
    wrap(async (req, res) => {
      const { country, status, q, programme } = req.query;

      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || 50));

      const where = { ...visibleTo(req.user) };

      /* ⚠ An exact match on the stored array, NOT the public `countryQuery`.
         The admin asking for "ca" wants the rows tagged Canada; folding in
         every global row as well would make the filter mean something else. */
      if (isCountryCode(country)) where.countries = country;
      if (STATUSES.includes(status)) where.status = status;

      /* Only for the types that HAVE a programme — asked of the schema rather
         than configured per resource, so a new content type with the field gets
         the filter automatically and one without it cannot be handed a query
         that silently matches nothing. */
      if (programme && model.schema.path("programme")) {
        /* ⚠ "Open to all" is a real filter value, not the absence of one, and
           it has to be a sentinel: an empty `?programme=` is indistinguishable
           from no filter at all by the time it reaches here. The site stores
           "not tied to a programme" as null, but a document written before the
           field existed can have it missing entirely, so both are matched. */
        where.programme = programme === NO_PROGRAMME ? { $in: [null, ""] } : programme;
      }

      if (typeof q === "string" && q.trim()) {
        const rx = new RegExp(escapeRegex(q.trim()), "i");
        where.$or = searchFields.map((field) => ({ [field]: rx }));
      }

      const [items, total] = await Promise.all([
        model
          .find(where)
          .sort(sort)
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        model.countDocuments(where),
      ]);

      res.json({ items: items.map(serialize), total, page, limit });
    })
  );

  router.get(
    "/:id",
    wrap(async (req, res) => {
      const doc = await model.findById(req.params.id).lean();
      if (!doc) throw notFound();
      res.json(serialize(doc));
    })
  );

  router.post(
    "/",
    validate(schema),
    wrap(async (req, res) => {
      assertCountryScope(req.user, req.body.countries);
      if (beforeSave) beforeSave(req.body, req);

      const doc = await model.create(req.body);
      res.status(201).json(serialize(doc.toObject()));
    })
  );

  /* PUT replaces every field; PATCH merges. Both run the same guards, so the
     difference is only how much of the document the caller has to restate. */
  const write = (partial) =>
    wrap(async (req, res) => {
      const doc = await model.findById(req.params.id);
      if (!doc) throw notFound();

      /* Both the document as it stands and as it would become have to be in
         scope: without the first check a scoped editor could take over a
         document belonging to another country by rewriting its `countries`. */
      assertCountryScope(req.user, doc.countries ?? []);

      const next = partial ? { ...doc.toObject(), ...req.body } : req.body;
      assertCountryScope(req.user, next.countries ?? []);
      if (beforeSave) beforeSave(next, req);

      /* Assigning onto the loaded document (rather than findByIdAndUpdate) is
         what makes Mongoose run the schema's own validators and the timestamp
         update, and keeps `updatedAt` honest. */
      doc.set(partial ? req.body : { ...req.body });
      await doc.save();

      res.json(serialize(doc.toObject()));
    });

  router.put("/:id", validate(schema), write(false));
  router.patch("/:id", validate(schema, { partial: true }), write(true));

  router.delete(
    "/:id",
    wrap(async (req, res) => {
      const doc = await model.findById(req.params.id);
      if (!doc) throw notFound();
      assertCountryScope(req.user, doc.countries ?? []);

      await doc.deleteOne();
      /* 204: there is no body worth sending, and the admin's list refetches. */
      res.status(204).end();
    })
  );

  return router;
}

export default crudRouter;
