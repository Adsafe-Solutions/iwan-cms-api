import { Router } from "express";
import rateLimit from "express-rate-limit";
import { Event } from "../models/Event.js";
import { Registration } from "../models/Registration.js";
import { badRequest, notFound, wrap } from "../lib/errors.js";
import { COUNTRY_CODES, countryQuery, isCountryCode } from "../lib/countries.js";
import { buildAnswers, summarise } from "../validators/registration.js";
import { sendRegistrationConfirmation } from "../lib/mail.js";

/* The one route on this API that the public can WRITE to.

   Everything else the world can reach is a GET. That makes this the whole
   attack surface for spam, junk data and someone filling the database one
   request at a time — hence the rate limit below, the capacity check, and the
   fact that validators/registration.js trusts nothing about the posted shape. */

const router = Router();

/* TWO limits, because there are two different things to protect against and one
   number cannot do both.

   ⚠ `skipFailedRequests` on the tight one is the important part. Counting
   rejected submissions would mean someone who mistypes their email three times
   is locked out for ten minutes — punished for filling in the form badly, which
   is not the behaviour anyone wants. What actually needs limiting is
   SUCCESSFUL writes, since those are what fill the database.

   Probing is then covered by the second, looser limit, which counts everything.

   ⚠ Both need `trust proxy` set on the app, or every request appears to come
   from the host's proxy and each becomes one global bucket — see app.js. */
const submissionLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  skipFailedRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: "That is a lot of sign-ups from one place. Try again in a few minutes.",
  },
});

/* The backstop: enough headroom for a person correcting a long form several
   times over, low enough that nobody is hammering this endpoint. */
const attemptLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 40,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again in a few minutes." },
});

const askedCountry = (req) => {
  const code = String(req.query.country ?? req.body?.country ?? "").toLowerCase();
  return isCountryCode(code) ? code : COUNTRY_CODES[0];
};

router.post(
  "/events/:slug/register",
  attemptLimiter,
  submissionLimiter,
  wrap(async (req, res) => {
    const country = askedCountry(req);

    /* ⚠ Only a PUBLISHED event in this country can be registered for. A draft
       is not public, and an event belonging to another country is not on offer
       here — in both cases the honest answer is that there is no such event. */
    const event = await Event.findOne({
      slug: req.params.slug,
      status: "published",
      ...countryQuery(country),
    }).lean();

    if (!event) throw notFound("No such event");

    if (!event.form?.length) {
      /* Should be impossible — publishing without a form is refused — but an
         event published before that rule existed would land here, and a 500
         would be a worse answer than saying so. */
      throw badRequest("This event is not taking registrations");
    }

    /* ⚠ Validated against the event's CURRENT form, not against whatever the
       browser thinks the form is. */
    const answers = buildAnswers(event.form, req.body?.answers ?? req.body ?? {});
    const { name, email } = summarise(answers);

    /* Capacity, where the event states one. Counted at submit time rather than
       held as a running total on the event: two people submitting at the same
       instant could both pass this check, which would put the event one over
       rather than silently losing a sign-up. Over by one is a problem an
       organiser can solve; a dropped registration is not. */
    if (Number.isFinite(event.spots) && event.spots > 0) {
      const taken = await Registration.countDocuments({
        event: event._id,
        status: { $in: ["new", "confirmed"] },
      });
      if (taken >= event.spots) {
        throw badRequest("This event is full", [
          { field: "form", message: "Every place has been taken." },
        ]);
      }
    }

    const registration = await Registration.create({
      event: event._id,
      eventSlug: event.slug,
      /* Snapshotted like the answers — a registration should still read
         properly if the event is renamed or removed. */
      eventTitle: event.title,
      country,
      answers,
      name,
      email,
    });

    /* ⚠ Deliberately thin. The person filling in the form does not need their
       own answers echoed back, and this response is public — the less it says
       about what is stored, the better. */
    res.status(201).json({
      ok: true,
      id: String(registration._id),
      event: { slug: event.slug, title: event.title },
    });

    /* ⚠ AFTER the response, and deliberately not awaited. The place is already
       booked; making the caller wait on an external mail API would add its
       latency to every sign-up, and making the 201 depend on it would turn a
       mail outage into an error the person retries — putting a second copy of
       them in the database. sendRegistrationConfirmation never throws, so this
       cannot reject into `wrap` and try to respond twice. */
    void sendRegistrationConfirmation({ registration, event });
  })
);

export default router;
