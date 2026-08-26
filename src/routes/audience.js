import { Router } from "express";
import { z } from "zod";
import { Audience, AUDIENCE_SOURCES } from "../models/Audience.js";
import { Application, APPLICATION_KINDS } from "../models/Application.js";
import { notFound, wrap } from "../lib/errors.js";
import { validate } from "../middleware/validate.js";
import { isCountryCode } from "../lib/countries.js";
import { adminApplication, adminAudience } from "../lib/serialize.js";
import { rowsToCsv, toCsv } from "../lib/csv.js";

/* Reading the audience list and the applications. Mounted under /api/admin, so
   already behind a sign-in and the read-only guard. */

const router = Router();
const MAX_LIMIT = 500;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const search = (q) => {
  const rx = new RegExp(escapeRegex(String(q).trim()), "i");
  return { $or: [{ name: rx }, { email: rx }, { mobile: rx }] };
};

const paging = (req) => ({
  page: Math.max(1, Number(req.query.page) || 1),
  limit: Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || 50)),
});

/* ── the audience ───────────────────────────────────────────────────────── */

const audienceWhere = (req) => {
  const { source, country, q, subscribed } = req.query;
  const where = {};

  if (AUDIENCE_SOURCES.includes(source)) where.sources = source;
  if (isCountryCode(country)) where.country = country;
  if (subscribed === "yes") where.subscribed = true;
  if (subscribed === "no") where.subscribed = false;
  if (typeof q === "string" && q.trim()) Object.assign(where, search(q));

  return where;
};

router.get(
  "/",
  wrap(async (req, res) => {
    const { page, limit } = paging(req);
    const where = audienceWhere(req);

    const [items, total] = await Promise.all([
      Audience.find(where)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Audience.countDocuments(where),
    ]);

    res.json({ items: items.map(adminAudience), total, page, limit });
  })
);

/* How many people each form has brought in — the numbers an organiser wants
   before a mailout, and the filter's own option counts. */
router.get(
  "/stats",
  wrap(async (_req, res) => {
    const [total, subscribed, bySource] = await Promise.all([
      Audience.countDocuments({}),
      Audience.countDocuments({ subscribed: true }),
      Audience.aggregate([
        { $unwind: "$sources" },
        { $group: { _id: "$sources", total: { $sum: 1 } } },
      ]),
    ]);

    res.json({
      total,
      subscribed,
      sources: Object.fromEntries(bySource.map((r) => [r._id, r.total])),
    });
  })
);

/* ⚠ Before `/:id`, or Express reads "export" as an id. */
router.get(
  "/export",
  wrap(async (req, res) => {
    const rows = await Audience.find(audienceWhere(req)).sort({ createdAt: 1 }).lean();
    /* ⚠ The messages are a list and a cell is not, so only the count travels —
       the CMS is where a message is read. */
    const csv = rowsToCsv(
      rows.map((doc) => {
        const row = adminAudience(doc);
        return { ...row, messages: row.messages.length };
      }),
      [
        ["email", "Email"],
        ["name", "Name"],
        ["mobile", "Mobile"],
        ["subscribed", "Subscribed"],
        ["sources", "Came from"],
        ["country", "Country"],
        ["messages", "Messages"],
        ["note", "Note"],
        ["firstSeenAt", "First seen"],
        ["lastSeenAt", "Last seen"],
      ]
    );

    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", 'attachment; filename="audience.csv"');
    res.send(csv);
  })
);

const audienceUpdate = z.object({
  /* ⚠ The one place `subscribed` can go back to false — see the model. */
  subscribed: z.boolean().optional(),
  name: z.string().trim().max(120).optional(),
  mobile: z.string().trim().max(32).optional(),
  note: z.string().trim().max(2000).optional(),
});

router.patch(
  "/:id",
  validate(audienceUpdate, { partial: true }),
  wrap(async (req, res) => {
    const row = await Audience.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    }).lean();
    if (!row) throw notFound("No such person");
    res.json(adminAudience(row));
  })
);

router.delete(
  "/:id",
  wrap(async (req, res) => {
    const row = await Audience.findByIdAndDelete(req.params.id);
    if (!row) throw notFound("No such person");
    res.status(204).end();
  })
);

export default router;

/* ── applications ───────────────────────────────────────────────────────── */

export const applicationRouter = Router();

const applicationWhere = (req) => {
  const { kind, country, status, q } = req.query;
  const where = {};

  if (APPLICATION_KINDS.includes(kind)) where.kind = kind;
  if (isCountryCode(country)) where.country = country;
  if (["new", "reviewing", "accepted", "declined"].includes(status))
    where.status = status;
  if (typeof q === "string" && q.trim()) Object.assign(where, search(q));

  return where;
};

applicationRouter.get(
  "/",
  wrap(async (req, res) => {
    const { page, limit } = paging(req);
    const where = applicationWhere(req);

    const [items, total] = await Promise.all([
      Application.find(where)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Application.countDocuments(where),
    ]);

    res.json({ items: items.map(adminApplication), total, page, limit });
  })
);

applicationRouter.get(
  "/export",
  wrap(async (req, res) => {
    const rows = await Application.find(applicationWhere(req))
      .sort({ createdAt: 1 })
      .lean();
    const csv = rowsToCsv(
      rows.map((doc) => {
        const row = adminApplication(doc);
        return {
          ...row,
          ...Object.fromEntries(row.answers.map((a) => [a.label, a.value])),
        };
      }),
      [
        ["kind", "Kind"],
        ["name", "Name"],
        ["email", "Email"],
        ["mobile", "Mobile"],
        ["role", "Role"],
        ["country", "Country"],
        ["status", "Status"],
        ["Availability", "Availability"],
        ["Experience", "Experience"],
        ["Portfolio or profile", "Portfolio"],
        ["About them", "About them"],
        ["note", "Note"],
        ["submittedAt", "Submitted"],
      ]
    );

    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", 'attachment; filename="applications.csv"');
    res.send(csv);
  })
);

const applicationUpdate = z.object({
  status: z.enum(["new", "reviewing", "accepted", "declined"]).optional(),
  note: z.string().trim().max(2000).optional(),
});

applicationRouter.patch(
  "/:id",
  validate(applicationUpdate, { partial: true }),
  wrap(async (req, res) => {
    const row = await Application.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    }).lean();
    if (!row) throw notFound("No such application");
    res.json(adminApplication(row));
  })
);

applicationRouter.delete(
  "/:id",
  wrap(async (req, res) => {
    const row = await Application.findByIdAndDelete(req.params.id);
    if (!row) throw notFound("No such application");
    res.status(204).end();
  })
);
