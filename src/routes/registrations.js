import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { Registration } from "../models/Registration.js";
import { Event } from "../models/Event.js";
import { badRequest, notFound, wrap } from "../lib/errors.js";
import { MAIL_ENABLED, sendRegistrationConfirmation } from "../lib/mail.js";
import { validate } from "../middleware/validate.js";
import { isCountryCode } from "../lib/countries.js";
import { adminRegistration } from "../lib/serialize.js";
import { toCsv } from "../lib/csv.js";

/* Reading and managing sign-ups. Mounted under /api/admin, so already behind a
   sign-in. */

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
    /* Name and email only — searching inside `answers` would be a regex scan
       of the whole array on every keystroke. */
    filter.$or = [{ name: rx }, { email: rx }];
  }

  return filter;
};

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

/* Which events have sign-ups, and how many. Counted from the registrations, so
   an event nobody signed up for does not clutter the filter. */
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
          /* ⚠ Cancellations do not take a place — same rule as submit time. */
          taken: {
            $sum: {
              $cond: [{ $in: ["$status", ["new", "confirmed"]] }, 1, 0],
            },
          },
        },
      },
      { $sort: { latest: -1 } },
    ]);

    /* Stated capacity, so the admin can show "12 of 40". */
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

/* ⚠ BEFORE `/:id`, or Express matches "export" as an id and every download
   becomes a 400 for a malformed ObjectId. */
router.get(
  "/export",
  wrap(async (req, res) => {
    const rows = await Registration.find(where(req)).sort({ createdAt: 1 }).lean();

    /* Columns come from the answers, so one event's spreadsheet is exactly
       that event's form. Across events the union is used, with blanks. */
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

/* ⚠ A limit on an already-authenticated endpoint, which looks redundant and is
   not: every other route here moves database rows, this one puts mail in a
   member of the public's inbox and cannot be walked back. High enough that a
   busy organiser never meets it, low enough to stop an inbox-bombing loop. */
const resendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: "That is a lot of confirmations at once. Try again in a few minutes.",
  },
});

/* Sends the confirmation again — it was deleted, went to spam, or never sent.
   Nothing changes on the registration except the record of the send.

   ⚠ AWAITED, unlike the public sign-up route which fires and forgets: the
   caller here is an editor whose entire question is whether it worked, and
   reporting success before knowing would make the button a placebo. */
router.post(
  "/:id/resend",
  resendLimiter,
  wrap(async (req, res) => {
    const registration = await Registration.findById(req.params.id);
    if (!registration) throw notFound("No such registration");

    /* Refused BEFORE calling Resend, so the editor gets the real reason. */
    if (!MAIL_ENABLED) {
      throw badRequest(
        "Email is not configured on this server, so nothing can be sent. Set RESEND_API_KEY and MAIL_FROM."
      );
    }

    if (!registration.email) {
      throw badRequest(
        "This registration has no email address — its form never asked for one, so there is nowhere to send."
      );
    }

    /* ⚠ Refused when CANCELLED: this message says "your place is confirmed",
       and sending that to someone who withdrew may bring them to the door.
       Reinstating first is one click and makes the intent explicit. */
    if (registration.status === "cancelled") {
      throw badRequest(
        "This registration is cancelled, and the confirmation says a place is booked. Change the status first if they are coming after all."
      );
    }

    /* The event as it stands NOW, so a resend carries a corrected date or
       venue. ⚠ May be null if the event was deleted; the message then falls
       back to the snapshotted title and omits the date. */
    const event = await Event.findById(registration.event).lean();

    const result = await sendRegistrationConfirmation({ registration, event });
    if (!result.sent) {
      throw badRequest(
        `The email could not be sent: ${result.reason ?? "unknown error"}`
      );
    }

    /* ⚠ Only now — the stamp means "reached the mail provider", so writing it
       earlier would make it a record of attempts dressed as one of sends. */
    registration.confirmationSentAt = new Date();
    registration.confirmationSentCount += 1;
    await registration.save();

    res.json(adminRegistration(registration.toObject()));
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
