import { CONFIG } from "../config.js";
import { resend } from "./resendClient.js";
import {
  firstNameOf,
  registrationValues,
  renderRegistrationConfirmation,
} from "./emails/registration.js";
import { renderNotification } from "./emails/notification.js";
import { renderSubscribeWelcome } from "./emails/subscribe.js";
import {
  applicationValues,
  renderApplicationConfirmation,
} from "./emails/application.js";
import { contactValues, renderContactConfirmation } from "./emails/contact.js";
import { unsubscribeUrl } from "./tokens.js";
import { background } from "./background.js";
import { resolveTemplate, variables } from "./templates.js";
import { isSubscribed } from "./audience.js";

/* Transactional mail: the TRANSPORT only — markup lives in emails/.

   ⚠ UNSET IS THE SWITCHED-OFF STATE. With no RESEND_API_KEY nothing is sent and
   sign-ups carry on, so a deployment without a key still works. The client
   itself is in resendClient.js, shared with the contact sync and the webhook. */

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

  /* ⚠ Empty unless API_URL is set — see lib/tokens.js. Everything below is
     conditional on it: a footer linking nowhere, or a List-Unsubscribe header
     pointing at localhost, is worse than not offering one. */
  const unsubscribe = unsubscribeUrl(registration.email);

  /* ⚠ THE LINK ITSELF IS ALWAYS REAL AND ALWAYS SENT. A Resend Template has no
     conditionals, so its unsubscribe block is shown to everybody; handing it an
     empty value would leave a button pointing at nothing, which is worse than
     showing it to somebody who never subscribed. The link is right for either —
     it takes a subscriber off the list, and does nothing for a person who was
     never on it.

     ⚠ `showLink` decides only whether the BUILT-IN message PRINTS the line. It
     renders in this process, so it can know the answer; a template on Resend's
     side cannot. The List-Unsubscribe header is on every message regardless. */
  const showLink = Boolean(unsubscribe) && (await isSubscribed(registration.email));

  /* ⚠ Canada's routes are country-prefixed and India's are not — `/ca/events`
     against `/events`. The site's router does that with a basename; the email
     has to build it by hand, and a Canadian registrant sent to India's event
     page is the mistake this prevents. */
  const country = registration.country === "ca" ? "ca" : "in";
  const eventUrl =
    CONFIG.siteUrl && event?.slug
      ? `${CONFIG.siteUrl.replace(/\/$/, "")}${country === "ca" ? "/ca" : ""}/events/${event.slug}`
      : "";

  const content = {
    name: registration.name,
    event: event ?? {},
    eventTitle: registration.eventTitle ?? "",
    eventUrl,
    /* ⚠ The real link, whoever this is — see above. `subscribed` below is what
       decides whether the built-in message prints it. */
    unsubscribeUrl: unsubscribe,
  };

  const { subject, html, text } = renderRegistrationConfirmation({
    ...content,
    country,
    subscribed: showLink,
  });

  /* ⚠ A published template in Resend REPLACES the message rendered above; the
     render still happens because its `subject` is the fallback when the
     template has none, and because the template may not exist. See
     lib/templates.js — a missing or draft template means the code is used, and
     a lookup that fails means the same. */
  const template = await resolveTemplate("registration", { country });

  const body = template
    ? {
        template: {
          id: template.id,
          /* ⚠ THE SAME VALUES THE BUILT-IN FILE GETS, lower-cased. One
             definition in emails/registration.js, so the Resend template and
             the file cannot drift apart.
             ⚠ LOWER-CASE BECAUSE RESEND RESERVES the upper-case FIRST_NAME,
             LAST_NAME, EMAIL and UNSUBSCRIBE_URL for its own substitution and
             refuses them as custom names — which is exactly why the token names
             in the HTML file cannot be reused here verbatim. */
          variables: variables(
            Object.fromEntries(
              Object.entries(registrationValues(content)).map(([key, value]) => [
                key.toLowerCase(),
                value,
              ])
            )
          ),
        },
        /* ⚠ Only when the template has none of its own — passing one always
           would override what was written in Resend. */
        ...(template.subject ? {} : { subject }),
      }
    : { subject, html, text };

  /* ⚠ The SDK REPORTS errors in the result rather than throwing, so try/catch
     alone would read a rejected send as a success. The catch covers the
     network-level failure it does throw on. */
  try {
    const { data, error } = await resend.emails.send({
      from: CONFIG.mailFrom,
      to: [registration.email],
      ...body,
      ...(CONFIG.mailReplyTo ? { replyTo: CONFIG.mailReplyTo } : {}),

      /* ⚠ THE HEADERS ARE THE HALF THAT MATTERS. Gmail and Apple Mail show
         their own unsubscribe button beside the sender name when these are
         present, and it is the one most people press — the footer link is for
         everyone else. Their presence is also what mailbox providers read as a
         sender behaving properly, which is worth more to the domain's
         reputation than the link itself.

         ⚠ The angle brackets are required by RFC 2369, and One-Click by RFC
         8058 — which is why routes/unsubscribe.js answers POST as well as GET,
         and answers it with an empty 200. */
      ...(unsubscribe
        ? {
            headers: {
              "List-Unsubscribe": `<${unsubscribe}>`,
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            },
          }
        : {}),
    });

    if (error) {
      return { sent: false, reason: error.message ?? "send-failed" };
    }

    return { sent: true, id: data?.id };
  } catch (err) {
    return { sent: false, reason: err?.message ?? "send-threw" };
  }
}

/**
 * Acknowledges a volunteer offer or a career application to the person who sent
 * it — the same courtesy the registration confirmation pays.
 *
 * ⚠ NEVER THROWS, same contract as every send here.
 *
 * ⚠ NO UNSUBSCRIBE LINK AND NO List-Unsubscribe HEADER, unlike the welcome and
 * the confirmation. This is a reply to something the person just sent, and
 * applying for a role is not joining a mailing list — offering to unsubscribe
 * them implies a subscription they never made. Anyone who ticked the newsletter
 * box on the same form gets the welcome separately, and that carries its own.
 *
 * @returns {Promise<{sent: boolean, reason?: string, id?: string}>}
 */
export async function sendApplicationConfirmation({
  kind = "volunteer",
  email,
  name = "",
  role = "",
  country = "",
}) {
  if (!MAIL_ENABLED) return { sent: false, reason: "mail-disabled" };
  if (!email) return { sent: false, reason: "no-address" };

  const siteUrl =
    CONFIG.siteUrl && country === "ca"
      ? `${CONFIG.siteUrl.replace(/\/$/, "")}/ca`
      : CONFIG.siteUrl;

  const { subject, html, text } = renderApplicationConfirmation({
    kind,
    name,
    role,
    siteUrl,
    country,
  });

  const template = await resolveTemplate("application", { country });

  const body = template
    ? {
        template: {
          id: template.id,
          /* ⚠ The same values the built-in message gets, lower-cased — one
             definition in emails/application.js, so the two cannot drift. */
          variables: variables({
            ...Object.fromEntries(
              Object.entries(applicationValues({ kind, name, role })).map(
                ([key, value]) => [key.toLowerCase(), value]
              )
            ),
            site_url: siteUrl,
          }),
        },
        ...(template.subject ? {} : { subject }),
      }
    : { subject, html, text };

  try {
    const { data, error } = await resend.emails.send({
      from: CONFIG.mailFrom,
      to: [email],
      ...body,
      ...(CONFIG.mailReplyTo ? { replyTo: CONFIG.mailReplyTo } : {}),
    });

    if (error) return { sent: false, reason: error.message ?? "send-failed" };
    return { sent: true, id: data?.id };
  } catch (err) {
    return { sent: false, reason: err?.message ?? "send-threw" };
  }
}

/**
 * Acknowledges a contact-form message to the person who sent it.
 *
 * ⚠ NEVER THROWS, same contract as every send here.
 *
 * ⚠ NO UNSUBSCRIBE LINK AND NO List-Unsubscribe HEADER. Writing to an
 * organisation is not joining its mailing list — this is a reply to something
 * the person just sent. Whoever ticked the newsletter box on the same form gets
 * the welcome separately, and that one carries its own.
 *
 * @returns {Promise<{sent: boolean, reason?: string, id?: string}>}
 */
export async function sendContactConfirmation({
  email,
  name = "",
  subject = "",
  message = "",
  country = "",
}) {
  if (!MAIL_ENABLED) return { sent: false, reason: "mail-disabled" };
  if (!email) return { sent: false, reason: "no-address" };

  const siteUrl =
    CONFIG.siteUrl && country === "ca"
      ? `${CONFIG.siteUrl.replace(/\/$/, "")}/ca`
      : CONFIG.siteUrl;

  const rendered = renderContactConfirmation({
    name,
    subject,
    message,
    siteUrl,
    country,
  });
  const template = await resolveTemplate("contact", { country });

  const body = template
    ? {
        template: {
          id: template.id,
          variables: variables({
            ...Object.fromEntries(
              Object.entries(contactValues({ name, subject, message })).map(
                ([key, value]) => [key.toLowerCase(), value]
              )
            ),
            site_url: siteUrl,
          }),
        },
        ...(template.subject ? {} : { subject: rendered.subject }),
      }
    : { subject: rendered.subject, html: rendered.html, text: rendered.text };

  try {
    const { data, error } = await resend.emails.send({
      from: CONFIG.mailFrom,
      to: [email],
      ...body,
      ...(CONFIG.mailReplyTo ? { replyTo: CONFIG.mailReplyTo } : {}),
    });

    if (error) return { sent: false, reason: error.message ?? "send-failed" };
    return { sent: true, id: data?.id };
  } catch (err) {
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
      return { sent: false, reason: error.message ?? "send-failed" };
    }
    return { sent: true, id: data?.id };
  } catch (err) {
    return { sent: false, reason: err?.message ?? "send-threw" };
  }
}

/**
 * The "you're on the list" email, sent once when somebody subscribes.
 *
 * ⚠ NEVER THROWS, same contract as the confirmation.
 *
 * ⚠ REFUSED WITHOUT AN UNSUBSCRIBE LINK. This is the one message here that is
 * marketing rather than transactional, and a marketing email with no way off
 * the list is the thing that gets a sending domain blocked. With API_URL unset
 * there is no link to build, so nothing is sent — loudly, in the return value,
 * rather than quietly sending something that should not exist.
 *
 * @returns {Promise<{sent: boolean, reason?: string, id?: string}>}
 */
export async function sendSubscribeWelcome({ email, name = "", country = "" }) {
  if (!MAIL_ENABLED) return { sent: false, reason: "mail-disabled" };
  if (!email) return { sent: false, reason: "no-address" };

  const unsubscribe = unsubscribeUrl(email);
  if (!unsubscribe) return { sent: false, reason: "no-unsubscribe-url" };

  /* ⚠ Canada's routes are country-prefixed and India's are not, the same trap
     the confirmation documents. The designed template links to the right root
     itself, but the CTA button is built from this. */
  const siteUrl =
    CONFIG.siteUrl && country === "ca"
      ? `${CONFIG.siteUrl.replace(/\/$/, "")}/ca`
      : CONFIG.siteUrl;

  const { subject, html, text } = renderSubscribeWelcome({
    name: firstNameOf(name),
    unsubscribeUrl: unsubscribe,
    siteUrl,
    country,
  });

  /* Same rule as the confirmation: Resend's template wins where there is a
     published one, the built-in message is the fallback. */
  const template = await resolveTemplate("welcome", { country });

  const body = template
    ? {
        template: {
          id: template.id,
          /* ⚠ EXACTLY the three the designed template declares — see the site
             repo's emails/subscribe-{in,ca}.html. A variable it declares and
             this does not send makes Resend REFUSE the send outright, so the
             two lists are a contract, not a convenience. */
          variables: variables({
            /* ⚠ First name only, as the greeting expects: "Assalamu alaikum
               Aisha". The same rule the confirmation uses. */
            first_name: firstNameOf(name),
            site_url: siteUrl,
            /* ⚠ OUR signed link. Resend fills its own UNSUBSCRIBE_URL for
               Broadcasts only; on a transactional send it fills nothing, so the
               link has to come from here or the button is dead. */
            unsubscribe_url: unsubscribe,
          }),
        },
        ...(template.subject ? {} : { subject }),
      }
    : { subject, html, text };

  try {
    const { data, error } = await resend.emails.send({
      from: CONFIG.mailFrom,
      to: [email],
      ...body,
      ...(CONFIG.mailReplyTo ? { replyTo: CONFIG.mailReplyTo } : {}),
      headers: {
        "List-Unsubscribe": `<${unsubscribe}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });

    if (error) {
      return { sent: false, reason: error.message ?? "send-failed" };
    }
    return { sent: true, id: data?.id };
  } catch (err) {
    return { sent: false, reason: err?.message ?? "send-threw" };
  }
}

/* ⚠ MUST BE AWAITED, and before the response — see lib/background.js. Off
   Vercel this returns immediately and the send finishes behind the response,
   exactly as it always did; on Vercel awaiting it is the only thing that keeps
   the function alive long enough for the send to happen at all.

   The rejection is still swallowed in there: sendNotification never throws, and
   this is belt and braces against a future edit that makes it. */
export const notify = (content) =>
  background("notification", () => sendNotification(content));

export default sendRegistrationConfirmation;
