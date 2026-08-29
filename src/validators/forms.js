import { z } from "zod";
import * as f from "./fields.js";

/* The subscribe and contact forms. ⚠ These sit on endpoints anyone can POST to,
   so nothing here trusts a length, a shape or a type.

   Volunteer and career are NOT here: their questions are built in the CMS, so
   they validate against the stored form through buildAnswers — see
   routes/forms.js. */

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
