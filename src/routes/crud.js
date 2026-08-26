import { Router } from "express";
import { notFound, wrap } from "../lib/errors.js";
import { validate } from "../middleware/validate.js";
import { assertCountryScope } from "../middleware/auth.js";
import { isCountryCode } from "../lib/countries.js";

/* Events, blogs, episodes and promos differ in their fields and nothing else,
   so this builds their router once: a fifth type is a model, a schema, a
   serialiser and one line. Anything a type does NOT share goes in `beforeSave`
   rather than becoming another flag on the factory. */

const STATUSES = ["draft", "published"];

/* "Not tied to any programme". A sentinel because an empty query value cannot
   be told apart from an absent one. ⚠ Starts with "__" so it can never collide
   with a real nav path, which always starts with "/". */
export const NO_PROGRAMME = "__none";

/* A typed search string goes into a RegExp — without escaping, a lone "(" is a
   500 and ".*" walks the whole collection. */
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const MAX_LIMIT = 200;

export function crudRouter({
  model,
  schema,
  serialize,
  sort = { updatedAt: -1 },
  searchFields = ["title", "slug"],
  /* For a rule the shared schema cannot express — see the promo window. */
  beforeSave,
}) {
  const router = Router();

  /* An unscoped account sees everything; a scoped editor sees only documents
     naming one of their countries. That hides global documents from them too,
     deliberately: `assertCountryScope` would refuse the edit anyway, and a list
     of rows that cannot be opened is worse than a shorter list. */
  const visibleTo = (user) =>
    user.role === "admin" || !user.countries?.length
      ? {}
      : { countries: { $in: user.countries } };

  /* The admin listing. Drafts included; that is the whole point. */
  router.get(
    "/",
    wrap(async (req, res) => {
      const { country, status, q, programme } = req.query;

      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || 50));

      const where = { ...visibleTo(req.user) };

      /* ⚠ An exact match, NOT the public `countryQuery` — folding in every
         global row would make the filter mean something else. */
      if (isCountryCode(country)) where.countries = country;
      if (STATUSES.includes(status)) where.status = status;

      /* Asked of the schema rather than configured per resource, so a type
         without the field cannot be handed a query that matches nothing. */
      if (programme && model.schema.path("programme")) {
        /* ⚠ "Open to all" is a real value, not the absence of one — an empty
           `?programme=` cannot be told apart from no filter here. Both null and
           missing are matched, since older documents lack the field. */
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

  /* PUT replaces, PATCH merges. Same guards either way. */
  const write = (partial) =>
    wrap(async (req, res) => {
      const doc = await model.findById(req.params.id);
      if (!doc) throw notFound();

      /* ⚠ Both the current and the resulting document must be in scope, or a
         scoped editor could take one over by rewriting its `countries`. */
      assertCountryScope(req.user, doc.countries ?? []);

      const next = partial ? { ...doc.toObject(), ...req.body } : req.body;
      assertCountryScope(req.user, next.countries ?? []);
      if (beforeSave) beforeSave(next, req);

      /* Assigning onto the loaded document, not findByIdAndUpdate, is what
         runs the schema validators and keeps `updatedAt` honest. */
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
      /* No body worth sending; the admin's list refetches. */
      res.status(204).end();
    })
  );

  return router;
}

export default crudRouter;
