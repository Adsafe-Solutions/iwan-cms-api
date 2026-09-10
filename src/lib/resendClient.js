import { Resend } from "resend";
import { CONFIG } from "../config.js";

/* THE Resend client — one per process, shared by everything that talks to
   Resend: the transactional mail in lib/mail.js, the contact sync in
   lib/contacts.js, and the signature check in routes/webhooks.js.

   ⚠ UNSET IS THE SWITCHED-OFF STATE, and this is where that decision is made
   once. With no RESEND_API_KEY this is `null`, and every caller reads that as
   "this feature is off" rather than as an error — a deployment without a key
   still takes sign-ups, still stores its audience, still answers its forms. It
   simply sends nothing and syncs nothing.

   ⚠ It lives in its own module rather than in mail.js because the webhook route
   needs `webhooks.verify` while sending nothing at all, and importing the mail
   transport to check a signature would drag the templates in behind it. */

export const resend = CONFIG.resendApiKey ? new Resend(CONFIG.resendApiKey) : null;

/* The client the WEBHOOK verifies with, which is a different question.

   ⚠ Checking a signature is arithmetic on bytes already in hand — `verify` makes
   no API call and the key is never read. But the constructor refuses to build
   without one ("Missing API key"), so a deployment that takes unsubscribes from
   broadcasts sent in Resend's own dashboard, and has no reason to hold a
   sending key, could not verify anything. The placeholder buys that case, and
   it is safe precisely because the one method used here never sends it
   anywhere.

   ⚠ It is NOT a fallback for sending. Everything that talks to the API uses
   `resend` above and stays switched off without a real key — routing a send
   through this would fail at Resend with an authentication error instead of
   quietly doing nothing, which is the behaviour the whole file exists to
   avoid. */
export const verifier = resend ?? new Resend("re_signature_verification_only_never_sent");

export default resend;
