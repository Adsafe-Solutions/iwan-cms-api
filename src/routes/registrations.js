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

/* ── resending the confirmation ─────────────────────────────────────────── */

/* ⚠ A limit on an endpoint that is ALREADY behind a sign-in, which looks
   redundant and is not. Every other route here moves rows in a database; this
   one puts mail in a member of the public's inbox, and that is the one action
   in this API a mistake cannot be walked back. The number is set so a busy
   organiser working through an event never meets it, while a stuck key repeat
   or a script running loose cannot turn the CMS into an inbox-bombing tool. */
const resendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: "That is a lot of confirmations at once. Try again in a few minutes.",
  },
});

/* Sends the confirmation for an existing registration again — someone deleted
   it, it went to spam, or it never sent because mail was not configured yet.
   Nothing about the registration changes except the record of the send.

   ⚠ AWAITED, unlike the public sign-up route which fires and forgets. There the
   caller is a member of the public whose place is already booked and who must
   not be made to wait on Resend; here the caller is an editor who pressed
   "Resend" and whose entire question is whether it worked. Reporting success
   before knowing would make the button a placebo. */
router.post(
  "/:id/resend",
  resendLimiter,
  wrap(async (req, res) => {
    const registration = await Registration.findById(req.params.id);
    if (!registration) throw notFound("No such registration");

    /* Each of these is refused BEFORE calling Resend, so the editor gets the
       actual reason rather than a generic failure from the mail API. */
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

    /* ⚠ Refused for a CANCELLED registration. The message this sends says "Your
       place is confirmed", and sending that to someone who withdrew is worse
       than sending nothing: they may turn up. Reinstating them first is one
       click, and makes the intent explicit rather than implied by a resend. */
    if (registration.status === "cancelled") {
      throw badRequest(
        "This registration is cancelled, and the confirmation says a place is booked. Change the status first if they are coming after all."
      );
    }

    /* The event as it stands NOW, so a resend carries a corrected date or venue
       rather than repeating what the original said. ⚠ May be null — the event
       can have been deleted since. The message falls back to the title
       snapshotted on the registration and simply omits the date. */
    const event = await Event.findById(registration.event).lean();

    const result = await sendRegistrationConfirmation({ registration, event });
    if (!result.sent) {
      throw badRequest(
        `The email could not be sent: ${result.reason ?? "unknown error"}`
      );
    }

    /* ⚠ Only now. See models/Registration.js — the stamp means "this reached
       the mail provider", so writing it before the send would make it a record
       of attempts wearing the clothes of a record of deliveries. */
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
