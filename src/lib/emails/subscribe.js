import { dropSection, lower, render } from "./render.js";

/* The "you're on the list" email, sent once when somebody subscribes.

   ⚠ SAME CONSTRAINTS AS registration.js — tables not divs, inline styles, hex
   colours — and the same palette, deliberately: someone who registered for an
   event last week and subscribes today should recognise both as Iwan.

   ⚠ THIS ONE IS MARKETING, not transactional. It is the message that starts a
   mailing relationship, so the unsubscribe link is NOT optional here the way it
   is on a booking confirmation — it is the first thing that makes the list
   honest. mail.js refuses to send this without one. */

/**
 * @returns {{subject: string, html: string, text: string}}
 */
export function renderSubscribeWelcome({
  name = "",
  unsubscribeUrl = "",
  siteUrl = "",
  country = "in",
  brandName = "Iwan Community",
} = {}) {
  const greeting = name ? `Hi ${name},` : "Hi,";
  const subject = `You're subscribed to ${brandName}`;
  const preheader = "You'll hear from us when there is something worth saying.";

  /* ⚠ The designed file in templates/ — the SAME one uploaded to Resend, so
     the fallback and the Template are the same message. */
  let html = render(`subscribe-${country === "ca" ? "ca" : "in"}.html`, {
    first_name: name,
    site_url: siteUrl,
    unsubscribe_url: unsubscribeUrl,
  });

  /* ⚠ No link means DROP THE ROW, not render an empty one — see dropSection.
     With API_URL unset there is nothing to point at, and a button leading
     nowhere is worse than no button. */
  if (!unsubscribeUrl) html = dropSection(html, "UNSUBSCRIBE");

  /* ⚠ Same rule as the unsubscribe row: no address to point at means DROP the
     button, not render one that goes nowhere. */
  if (!siteUrl) html = dropSection(html, "CTA");

  const text = [
    greeting,
    "",
    "Thank you for subscribing. We will write when there is an event worth coming to or something worth reading — not otherwise.",
    "",
    siteUrl && `See what's on: ${siteUrl}`,
    "",
    /* ⚠ "Team Iwan", not the brand name — it matches how the designed
       templates sign off, and a person reads one immediately after the other.
       `brandName` still names the organisation in the sentences ABOUT it. */
    "— Team Iwan",
    "",
    `Unsubscribe: ${unsubscribeUrl}`,
  ]
    .filter((line) => line !== false && line !== undefined)
    .join("\n");

  return { subject, html, text };
}

export default renderSubscribeWelcome;
