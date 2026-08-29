import { Router } from "express";
import rateLimit from "express-rate-limit";
import { CONFIG } from "../config.js";
import { Application } from "../models/Application.js";
import { badRequest, wrap } from "../lib/errors.js";
import { validate } from "../middleware/validate.js";
import { recordAudience } from "../lib/audience.js";
import { COUNTRY_CODES, isCountryCode } from "../lib/countries.js";
import { buildAnswers, summarise } from "../validators/registration.js";
import { contactInput, subscribeInput } from "../validators/forms.js";
import { resolveApplyForm } from "../lib/applyForms.js";

/* The public forms: subscribe, contact, volunteer and career. Event sign-ups
   are next door in register.js.

   ⚠ Every one of these is a write anyone on the internet can make, so they all
   share the limits below and all answer the same thin `{ ok: true }` — a form
   that echoes back what it stored tells a prober what it stored. */

const router = Router();

/* ⚠ `skipFailedRequests`, for the reason register.js documents: counting
   rejected submissions punishes someone who mistypes their own email. What
   needs limiting is SUCCESSFUL writes, since those are what fill the database.
   Both limits need `trust proxy` on the app — see app.js. */
const writeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: CONFIG.formWriteLimit,
  skipFailedRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "That is a lot of submissions from one place. Try again shortly." },
});

const attemptLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: CONFIG.formAttemptLimit,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again in a few minutes." },
});

const askedCountry = (req) => {
  const code = String(req.query.country ?? req.body?.country ?? "").toLowerCase();
  return isCountryCode(code) ? code : COUNTRY_CODES[0];
};

const ok = (res) => res.status(201).json({ ok: true });

router.post(
  "/subscribe",
  attemptLimiter,
  writeLimiter,
  validate(subscribeInput),
  wrap(async (req, res) => {
    await recordAudience({
      ...req.body,
      subscribe: true,
      source: "subscribe",
      country: askedCountry(req),
    });
    ok(res);
  })
);

router.post(
  "/contact",
  attemptLimiter,
  writeLimiter,
  validate(contactInput),
  wrap(async (req, res) => {
    const { subject, message, ...person } = req.body;
    await recordAudience({
      ...person,
      source: "contact",
      country: askedCountry(req),
      message: { subject, body: message },
    });
    ok(res);
  })
);

/* ── volunteer and career ───────────────────────────────────────────────── */

/* ⚠ Validated against the form the CMS holds, not a fixed schema — the same
   contract as an event's registration. The questions are content now, so a key
   the form does not define is dropped rather than stored, and a choice answer
   that is not one of the offered options is refused.

   The built-in list is the fallback for a deployment where nobody has opened
   the CMS yet: without it these pages would refuse every submission until an
   editor saved a form, which is a worse first day than a sensible default. */
const application = (kind) => [
  attemptLimiter,
  writeLimiter,
  wrap(async (req, res) => {
    const country = askedCountry(req);

    /* ⚠ The SAME resolution the site rendered from, so a submission is checked
       against the questions the visitor was actually shown. */
    const form = await resolveApplyForm(kind, country);
    if (!form) {
      throw badRequest("This form is not accepting applications right now");
    }
    const { fields } = form;

    const answers = buildAnswers(fields, req.body?.answers ?? req.body ?? {});
    const { name, email, mobile } = summarise(answers);

    /* ⚠ Guarded here as well as in the CMS. assertApplyFormIsSound refuses to
       SAVE a form with no email question, but a form stored before that rule
       existed would otherwise land an application nobody can answer. */
    if (!email) {
      throw badRequest("An email address is required", [
        { field: "form", message: "This form is missing its email question." },
      ]);
    }

    /* The role, where the form asks for one. Read by key rather than position
       so an editor can move it, and simply absent when they do not ask. */
    const role = String(answers.find((a) => a.key === "role")?.value ?? "").slice(0, 200);

    /* The audience row first, so the application can point at it. */
    const person = await recordAudience({
      email,
      name,
      mobile,
      subscribe: typeof req.body?.subscribe === "boolean" ? req.body.subscribe : false,
      source: kind,
      country,
    });

    await Application.create({
      kind,
      email,
      name,
      mobile,
      role,
      country,
      audience: person?._id,
      answers,
    });

    ok(res);
  }),
];

router.post("/volunteer", ...application("volunteer"));
router.post("/career", ...application("career"));

export default router;
