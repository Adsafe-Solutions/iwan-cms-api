import { Resend } from "resend";
import { CONFIG } from "../config.js";
import { renderRegistrationConfirmation } from "./emails/registration.js";

/* Transactional mail: the TRANSPORT only — markup lives in emails/.

   ⚠ UNSET IS THE SWITCHED-OFF STATE. With no RESEND_API_KEY nothing is sent and
   sign-ups carry on, so a deployment without a key still works. */

const resend = CONFIG.resendApiKey ? new Resend(CONFIG.resendApiKey) : null;

export const MAIL_ENABLED = Boolean(resend && CONFIG.mailFrom);

/* `date` is a plain day string, so there is no timezone to convert.

   ⚠ `?? {}` rather than a default parameter: a default only fills in for
   `undefined`, and the admin's resend passes a findById result, which is NULL
   for a deleted event. The registration survives that and can still be sent. */
const formatWhen = (event) => {
  const e = event ?? {};
  const time = [e.start, e.end].filter(Boolean).join("–");
  return [e.date, time].filter(Boolean).join(", ");
};

/**
 * Sends the confirmation for one registration.
 *
 * ⚠ NEVER THROWS — the place is already booked, and a mail outage must not turn
 * a successful sign-up into an error the person retries. Failures come back in
 * the return value.
 *
 * @returns {Promise<{sent: boolean, reason?: string, id?: string}>}
 */
export async function sendRegistrationConfirmation({ registration, event }) {
  if (!MAIL_ENABLED) return { sent: false, reason: "mail-disabled" };

  /* A form with no email question stores "". Nowhere to send, not an error. */
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

  /* ⚠ The SDK REPORTS errors in the result rather than throwing, so try/catch
     alone would read a rejected send as a success. The catch covers the
     network-level failure it does throw on. */
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
