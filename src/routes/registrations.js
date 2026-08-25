import { Router } from "express";
import { z } from "zod";
import { Registration } from "../models/Registration.js";
import { Event } from "../models/Event.js";
import { notFound, wrap } from "../lib/errors.js";
import { validate } from "../middleware/validate.js";
import { isCountryCode } from "../lib/countries.js";
import { adminRegistration } from "../lib/serialize.js";
import { toCsv } from "../lib/csv.js";

/* Reading and managing sign-ups. Mounted under /api/admin, so everything here
   is already behind a sign-in. */

const router = Router();

const STATUSES = ["new", "confirmed", "waitlist", "cancelled"];
const MAX_LIMIT = 200;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const where = (req) => {
  const { event, status, country, q } = req.query;
  const filter = {};

  if (typeof event === "string" && event) filter.eventSlug = event;
  if (STATUSES.includes(status)) filter.status = status;
  if (isCountryCode(country)) filter.country = country;

  if (typeof q === "string" && q.trim()) {
    const rx = new RegExp(escapeRegex(q.trim()), "i");
    /* Name and email only. Searching inside every answer would mean a regex
       scan of the whole `answers` array on every keystroke, and the two fields
       people actually search by are lifted out for exactly this. */
    filter.$or = [{ name: rx }, { email: rx }];
  }

  return filter;
};

/* ── the list ───────────────────────────────────────────────────────────── */

router.get(
  "/",
  wrap(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || 50));
    const filter = where(req);

    const [items, total] = await Promise.all([
      Registration.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Registration.countDocuments(filter),
    ]);

    res.json({ items: items.map(adminRegistration), total, page, limit });
  })
);

/* Which events have sign-ups, and how many — what the filter dropdown needs,
   and a useful answer on its own. Counted from the registrations rather than
   listing every event, so an event nobody has signed up for does not clutter
   the filter. */
router.get(
  "/events",
  wrap(async (_req, res) => {
    const rows = await Registration.aggregate([
      {
        $group: {
          _id: "$eventSlug",
          title: { $last: "$eventTitle" },
          total: { $sum: 1 },
          latest: { $max: "$createdAt" },
          /* ⚠ Cancellations do not count towards a place being taken, which is
             the same rule the public endpoint applies at submit time. */
          taken: {
            $sum: {
              $cond: [{ $in: ["$status", ["new", "confirmed"]] }, 1, 0],
            },
          },
        },
      },
      { $sort: { latest: -1 } },
    ]);

    /* The event's stated capacity, so the admin can show "12 of 40". */
    const events = await Event.find({ slug: { $in: rows.map((r) => r._id) } })
      .select("slug spots date")
      .lean();
    const bySlug = Object.fromEntries(events.map((e) => [e.slug, e]));

    res.json({
      items: rows.map((r) => ({
        slug: r._id,
        title: r.title || r._id,
        total: r.total,
        taken: r.taken,
        spots: bySlug[r._id]?.spots ?? null,
        date: bySlug[r._id]?.date ?? "",
        latest: r.latest,
      })),
    });
  })
);

/* ⚠ Registered BEFORE `/:id`, or Express matches "export" as an id and every
   download becomes a 400 for a malformed ObjectId. */
router.get(
  "/export",
  wrap(async (req, res) => {
    const rows = await Registration.find(where(req)).sort({ createdAt: 1 }).lean();

    /* One column per question, which means the columns come from the answers
       themselves — a spreadsheet of a single event is then exactly that event's
       form. Across events the union is used, and a row simply has blanks where
       its form did not ask. */
    const csv = toCsv(rows.map(adminRegistration));

    const name = req.query.event ? `registrations-${req.query.event}` : "registrations";
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="${name}.csv"`);
    res.send(csv);
  })
);

router.get(
  "/:id",
  wrap(async (req, res) => {
    const row = await Registration.findById(req.params.id).lean();
    if (!row) throw notFound("No such registration");
    res.json(adminRegistration(row));
  })
);

const updateInput = z.object({
  status: z.enum(STATUSES).optional(),
  note: z.string().trim().max(2000).optional(),
});

router.patch(
  "/:id",
  validate(updateInput, { partial: true }),
  wrap(async (req, res) => {
    const row = await Registration.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    }).lean();
    if (!row) throw notFound("No such registration");
    res.json(adminRegistration(row));
  })
);

router.delete(
  "/:id",
  wrap(async (req, res) => {
    const row = await Registration.findByIdAndDelete(req.params.id);
    if (!row) throw notFound("No such registration");
    res.status(204).end();
  })
);

export default router;
