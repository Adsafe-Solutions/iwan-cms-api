import { Resend } from "resend";
import { CONFIG } from "../config.js";
import { renderRegistrationConfirmation } from "./emails/registration.js";
import { renderNotification } from "./emails/notification.js";

/* Transactional mail: the TRANSPORT only — markup lives in emails/.

   ⚠ UNSET IS THE SWITCHED-OFF STATE. With no RESEND_API_KEY nothing is sent and
   sign-ups carry on, so a deployment without a key still works. */

const resend = CONFIG.resendApiKey ? new Resend(CONFIG.resendApiKey) : null;

export const MAIL_ENABLED = Boolean(resend && CONFIG.mailFrom);

/* Notifying Iwan needs somewhere to notify. Separate from MAIL_ENABLED: a
   deployment can perfectly well confirm to registrants without telling
   anyone internally, and did until this existed. */
export const NOTIFY_ENABLED = Boolean(MAIL_ENABLED && CONFIG.mailTo.length);

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

/**
 * Tells Iwan that a form was filled in.
 *
 * ⚠ NEVER THROWS, and callers do not await it — the submission is already
 * saved and answered. A notification that cannot be sent is a notification
 * nobody gets, not a form that failed.
 *
 * `replyTo` is the SUBMITTER's address where there is one, so replying from
 * the inbox writes back to the person rather than to Iwan itself.
 *
 * @returns {Promise<{sent: boolean, reason?: string, id?: string}>}
 */
export async function sendNotification({ replyTo, ...content }) {
  if (!NOTIFY_ENABLED) return { sent: false, reason: "notify-disabled" };

  const { subject, html, text } = renderNotification(content);

  try {
    const { data, error } = await resend.emails.send({
      from: CONFIG.mailFrom,
      to: CONFIG.mailTo,
      subject,
      text,
      html,
      ...(replyTo ? { replyTo } : {}),
    });

    if (error) {
      console.error("Notification email failed:", error);
      return { sent: false, reason: error.message ?? "send-failed" };
    }
    return { sent: true, id: data?.id };
  } catch (err) {
    console.error("Notification email threw:", err);
    return { sent: false, reason: err?.message ?? "send-threw" };
  }
}

/* ⚠ Fire-and-forget, with the rejection swallowed. sendNotification already
   never throws, so this is belt and braces against a future edit that makes
   it — an unhandled rejection takes the process down on Node. */
export const notify = (content) => {
  void sendNotification(content).catch((err) =>
    console.error("Notification threw past its own guard:", err)
  );
};

export default sendRegistrationConfirmation;
