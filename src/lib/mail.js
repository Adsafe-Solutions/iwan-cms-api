import { Resend } from "resend";
import { CONFIG } from "../config.js";
import { renderRegistrationConfirmation } from "./emails/registration.js";

/* Transactional mail: the TRANSPORT only. What a message looks like lives in
   emails/, so the markup can be changed without touching sending, and vice
   versa.

   ⚠ UNSET IS THE SWITCHED-OFF STATE, the same way VITE_CMS_API_URL is on the
   site. With no RESEND_API_KEY nothing is sent and registration carries on
   exactly as it did before this file existed — so a deployment that has not
   been given a key yet still takes sign-ups rather than refusing to boot. */

const resend = CONFIG.resendApiKey ? new Resend(CONFIG.resendApiKey) : null;

export const MAIL_ENABLED = Boolean(resend && CONFIG.mailFrom);

/* The event's own date, printed as written. `date` is a plain day string, not a
   timestamp, so there is no timezone to convert between. */
const formatWhen = (event = {}) => {
  const time = [event.start, event.end].filter(Boolean).join("–");
  return [event.date, time].filter(Boolean).join(", ");
};

/**
 * Sends the confirmation for one registration.
 *
 * ⚠ NEVER THROWS. The caller has already created the registration and
 * answered 201 — the person's place is booked. A mail outage must not turn a
 * successful sign-up into an error they are asked to retry, which would put a
 * second copy of them in the database. Failures are logged and reported in the
 * return value instead.
 *
 * @returns {Promise<{sent: boolean, reason?: string, id?: string}>}
 */
export async function sendRegistrationConfirmation({ registration, event }) {
  if (!MAIL_ENABLED) return { sent: false, reason: "mail-disabled" };

  /* A form with no email question stores an empty string — see the Registration
     model. There is nowhere to send to, and that is not an error. */
  if (!registration?.email) return { sent: false, reason: "no-address" };

  const { subject, html, text } = renderRegistrationConfirmation({
    name: registration.name,
    eventTitle: event?.title ?? registration.eventTitle ?? "",
    when: formatWhen(event),
    where: [event?.venue, event?.address].filter(Boolean).join(", "),
    eventUrl:
      CONFIG.siteUrl && event?.slug
        ? `${CONFIG.siteUrl.replace(/\/$/, "")}/events/${event.slug}`
        : "",
  });

  /* ⚠ The SDK REPORTS errors in the result rather than throwing them, so a
     try/catch alone would treat a rejected send as a success. The catch is
     still here for a network-level failure. */
  try {
    const { data, error } = await resend.emails.send({
      from: CONFIG.mailFrom,
      to: [registration.email],
      subject,
      text,
      html,
      ...(CONFIG.mailReplyTo ? { replyTo: CONFIG.mailReplyTo } : {}),
    });

    if (error) {
      console.error("Confirmation email failed:", error);
      return { sent: false, reason: error.message ?? "send-failed" };
    }

    return { sent: true, id: data?.id };
  } catch (err) {
    console.error("Confirmation email threw:", err);
    return { sent: false, reason: err?.message ?? "send-threw" };
  }
}

export default sendRegistrationConfirmation;
