import { z } from "zod";
import * as f from "./fields.js";

/* The public forms. ⚠ These sit on endpoints anyone can POST to, so nothing
   here trusts a length, a shape or a type — same stance as the registration
   validator next door. */

const email = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "An email address is required")
  .max(200)
  .email("That is not an email address");

/* Loose on purpose: numbers arrive with spaces, brackets, +country codes and
   local formats this service has no business ruling on. Long enough for any of
   them, short enough not to be a text field in disguise. */
const mobile = z.string().trim().max(32).default("");

const name = z.string().trim().max(120).default("");

export const subscribeInput = z.object({
  email,
  /* The newsletter box is a subscription by definition, but the flag is still
     sent so one code path serves every form. */
  subscribe: z.boolean().default(true),
});

export const contactInput = z.object({
  email,
  name: name.pipe(z.string().min(1, "A name is required")),
  subject: z.string().trim().min(1, "A subject is required").max(200),
  mobile,
  /* Optional, and deliberately so — a subject line is often the whole message. */
  message: z.string().trim().max(5000).default(""),
  subscribe: z.boolean().default(true),
});

const applicationBase = {
  email,
  name: name.pipe(z.string().min(1, "A name is required")),
  mobile: mobile.pipe(z.string().min(1, "A mobile number is required")),
  role: z.string().trim().max(200).default(""),
  subscribe: z.boolean().default(true),
};

export const volunteerInput = z.object({
  ...applicationBase,
  availability: z.string().trim().max(200).default(""),
  about: z.string().trim().min(1, "Tell us a little about yourself").max(5000),
});

export const careerInput = z.object({
  ...applicationBase,
  role: z.string().trim().min(1, "Which role are you applying for?").max(200),
  experience: z.string().trim().max(200).default(""),
  /* ⚠ No CV upload, by decision. There is no file store behind this service and
     an upload endpoint is a very different piece of work; a link to something
     they already host is what the form asks for instead. */
  portfolio: f.url,
  about: z.string().trim().min(1, "Tell us about your experience").max(5000),
});

/* Turns a validated body into the snapshotted answers an Application stores, so
   the CMS renders whatever a form asked without knowing the questions.

   ⚠ EVERY question this kind asks, including the ones left blank. Dropping the
   empties would lose the only record that the question was PUT — and the CMS
   table needs to tell "we never asked this" from "they did not answer", which
   it can then do from the row alone rather than from a copy of these lists. */
export const answersFrom = (body, questions) =>
  questions.map(({ key, label, type }) => ({
    key,
    label,
    type,
    value: body[key] ?? "",
  }));

export const VOLUNTEER_QUESTIONS = [
  { key: "availability", label: "Availability", type: "text" },
  { key: "about", label: "About them", type: "textarea" },
];

export const CAREER_QUESTIONS = [
  { key: "experience", label: "Experience", type: "text" },
  { key: "portfolio", label: "Portfolio or profile", type: "text" },
  { key: "about", label: "About them", type: "textarea" },
];
