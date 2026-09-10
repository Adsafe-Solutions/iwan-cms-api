import { timingSafeEqual } from "node:crypto";
import { CONFIG } from "../config.js";
import { forbidden } from "../lib/errors.js";

/* Proves a public submission came through the site's Cloudflare Worker.

   ⚠ THIS IS WHAT MAKES TURNSTILE WORTH ANYTHING. The Worker verifies the
   Turnstile token and then forwards the form here — but this API is on its own
   hostname, and anything that finds it can POST straight to it. Without this
   check the bot protection is one hop that a bot simply skips, and the site's
   own Worker even logs a warning saying so.

   ⚠ UNSET IS OFF, deliberately. A deployment that has not been given the shared
   secret keeps taking forms rather than refusing every visitor — the failure
   mode of a missing variable must not be a site whose forms all break. The
   trade is that it protects nothing until it is set, which is why it says so
   in the log at boot.

   ⚠ It does NOT guard the unsubscribe route or the Resend webhook: neither
   comes through the Worker. One is a link in somebody's inbox, the other is a
   third party with its own signature. */

const HEADER = "x-forward-secret";

/* ⚠ Length is compared first because timingSafeEqual THROWS on a mismatch, and
   the length of a secret is not the secret. */
const matches = (given, expected) => {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

export const requireForwarded = (req, _res, next) => {
  if (!CONFIG.cmsForwardSecret) return next();

  if (!matches(req.get(HEADER), CONFIG.cmsForwardSecret)) {
    /* ⚠ The same message a bot would get for any other refusal, and nothing
       about which check failed — telling a spammer what is missing is telling
       them what to send. The reason goes to the log. */
    console.warn(
      `[forwarded] refused ${req.method} ${req.originalUrl} — no valid ${HEADER}`
    );
    throw forbidden("This form could not be verified. Please try again.");
  }

  return next();
};

export default requireForwarded;
