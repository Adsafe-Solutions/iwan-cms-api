import { Router } from "express";
import rateLimit from "express-rate-limit";
import { Application } from "../models/Application.js";
import { wrap } from "../lib/errors.js";
import { validate } from "../middleware/validate.js";
import { recordAudience } from "../lib/audience.js";
import { COUNTRY_CODES, isCountryCode } from "../lib/countries.js";
import {
  answersFrom,
  careerInput,
  contactInput,
  subscribeInput,
  volunteerInput,
  CAREER_QUESTIONS,
  VOLUNTEER_QUESTIONS,
} from "../validators/forms.js";

/* The public forms: subscribe, contact, volunteer and career. Event sign-ups
   are next door in register.js, which has its own per-event validation.

   ⚠ Every one of these is a write anyone on the internet can make, so they all
   share the limits below and all answer the same thin `{ ok: true }` — a form
   that echoes back what it stored is a form that tells a prober what it
   stored. */

const router = Router();

/* ⚠ `skipFailedRequests`, for the reason register.js documents: counting
   rejected submissions punishes someone who mistypes their own email. What
   needs limiting is SUCCESSFUL writes, since those are what fill the database.
   Both limits need `trust proxy` on the app — see app.js. */
const writeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 8,
  skipFailedRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "That is a lot of submissions from one place. Try again shortly." },
});

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

/* Volunteer and career differ only in their questions, so the route is built
   once — a third kind is an entry here, not another handler. */
const application = (kind, schema, questions) => [
  attemptLimiter,
  writeLimiter,
  validate(schema),
  wrap(async (req, res) => {
    const country = askedCountry(req);
    const { email, name, mobile, role, subscribe } = req.body;

    /* ⚠ The audience row first, so the application can point at it. A person
       who applies is reachable from the one list even if the application is
       later deleted. */
    const person = await recordAudience({
      email,
      name,
      mobile,
      subscribe,
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
      answers: answersFrom(req.body, questions),
    });

    ok(res);
  }),
];

router.post(
  "/volunteer",
  ...application("volunteer", volunteerInput, VOLUNTEER_QUESTIONS)
);
router.post("/career", ...application("career", careerInput, CAREER_QUESTIONS));

export default router;
