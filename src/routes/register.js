import { Router } from "express";
import rateLimit from "express-rate-limit";
import { Event } from "../models/Event.js";
import { Registration } from "../models/Registration.js";
import { badRequest, notFound, wrap } from "../lib/errors.js";
import { COUNTRY_CODES, countryQuery, isCountryCode } from "../lib/countries.js";
import { buildAnswers, summarise } from "../validators/registration.js";
import { notify, sendRegistrationConfirmation } from "../lib/mail.js";
import { recordAudience } from "../lib/audience.js";
import { CONFIG } from "../config.js";

/* The one route the public can WRITE to, and therefore the whole attack surface
   for spam and junk data — hence the rate limits below, the capacity check, and
   validators/registration.js trusting nothing about the posted shape. */

const router = Router();

/* TWO limits: one number cannot protect against both filling the database and
   probing. ⚠ `skipFailedRequests` is the important part — counting rejected
   submissions would lock out someone who mistyped their email three times. Only
   SUCCESSFUL writes need limiting; the looser limit below covers probing.
   ⚠ Both need `trust proxy` on the app or every request shares one bucket. */
const submissionLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: CONFIG.registerWriteLimit,
  skipFailedRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: "That is a lot of sign-ups from one place. Try again in a few minutes.",
  },
});

/* The backstop: headroom for someone correcting a long form repeatedly. */
const attemptLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: CONFIG.registerAttemptLimit,
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

    /* ⚠ Only a PUBLISHED event in this country. For a draft or another
       country's event, the honest answer is that there is no such event. */
    const event = await Event.findOne({
      slug: req.params.slug,
      status: "published",
      ...countryQuery(country),
    }).lean();

    if (!event) throw notFound("No such event");

    if (!event.form?.length) {
      /* Should be impossible, but an event published before that rule existed
         would land here, and a 500 would be a worse answer. */
      throw badRequest("This event is not taking registrations");
    }

    /* ⚠ Validated against the event's CURRENT form, not against whatever the
       browser thinks the form is. */
    const answers = buildAnswers(event.form, req.body?.answers ?? req.body ?? {});
    const summarised = summarise(answers);
    const { name, email } = summarised;

    /* Counted at submit time rather than kept as a running total: two
       simultaneous submissions can both pass, putting the event one over rather
       than silently losing a sign-up. Over by one is a problem an organiser can
       solve; a dropped registration is not. */
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

    /* Both read twice — once to store, once for the notification below. */
    const photoConsent =
      typeof req.body?.photoConsent === "boolean" ? req.body.photoConsent : null;
    const subscribed =
      typeof req.body?.subscribe === "boolean"
        ? req.body.subscribe
        : summarised.subscribe;

    const registration = await Registration.create({
      event: event._id,
      eventSlug: event.slug,
      /* Snapshotted, so this still reads properly if the event is renamed. */
      eventTitle: event.title,
      country,
      answers,
      name,
      email,
      /* Same beside-the-answers convention as `subscribe` below. Only an
         explicit boolean counts; anything else records null — no answer. */
      photoConsent,
    });

    /* ⚠ Awaited, unlike the confirmation email below. This is a database write
       to the same cluster, not a call to a third party, and a sign-up that
       silently failed to reach the audience list is the kind of gap nobody
       notices until a mailout goes out short. `subscribe` comes off the form
       when it asks; an event that does not ask still adds the person, just not
       to the newsletter. */
    await recordAudience({
      email,
      name,
      mobile: summarised.mobile,
      /* ⚠ Sent alongside the answers, not inside them: buildAnswers drops any
         key the event's own form does not define, so a checkbox the SITE adds
         to every form would never survive validation. An event whose form asks
         the question itself still works — summarise reads that consent — and
         this only takes over when the caller states it outright. */
      subscribe: subscribed,
      source: "event",
      country,
    });

    /* ⚠ Deliberately thin — this response is public, so the less it says about
       what is stored, the better. */
    res.status(201).json({
      ok: true,
      id: String(registration._id),
      event: { slug: event.slug, title: event.title },
    });

    /* ⚠ Iwan's own heads-up, beside the registrant's confirmation and after
       the response for the same reason: the place is booked either way. The
       ANSWERS are included so the inbox is enough to act on without opening
       the CMS. */
    notify({
      subject: `New registration: ${event.title}`,
      heading: "Someone registered for an event",
      intro: `${name || "Someone"} signed up for ${event.title}.`,
      rows: [
        ["Event", event.title],
        [
          "When",
          [event.date, [event.start, event.end].filter(Boolean).join("–")]
            .filter(Boolean)
            .join(", "),
        ],
        ["Name", name],
        ["Email", email],
        ["Mobile", summarised.mobile],
        ["Country", country.toUpperCase()],
        ...answers.map((a) => [a.label, a.value]),
        ["Newsletter", subscribed],
        ["Photos", photoConsent === null ? "" : photoConsent],
      ],
      cmsUrl: CONFIG.cmsUrl
        ? `${CONFIG.cmsUrl}/event-registrations?event=${event.slug}`
        : "",
      cmsLabel: "See it in the CMS",
      replyTo: email || undefined,
    });

    /* ⚠ AFTER the response and not awaited. Making the 201 depend on a mail
       API would turn an outage into an error the person retries, putting a
       second copy of them in the database. sendRegistrationConfirmation never
       throws, so this cannot reject into `wrap` and respond twice.

       The stamp is what lets the CMS say whether this person was ever written
       to. ⚠ `updateOne` rather than saving the document — re-saving the copy
       captured in this closure would write back a stale doc — and the `.catch`
       stops a failed stamp becoming an unhandled rejection. */
    void sendRegistrationConfirmation({ registration, event })
      .then((result) => {
        if (!result.sent) return null;
        return Registration.updateOne(
          { _id: registration._id },
          {
            $set: { confirmationSentAt: new Date() },
            $inc: { confirmationSentCount: 1 },
          }
        );
      })
      .catch((err) => {
        console.error("Could not record the confirmation send:", err);
      });
  })
);

export default router;
