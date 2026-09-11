import { dropSection, lower, render } from "./render.js";

/* "We have your message" — the acknowledgement for the contact form.

   ⚠ RESEND'S TEMPLATE WINS WHERE THERE IS ONE, under
   `iwan-contact-{in,ca}`; this renders when there is no published one or
   Resend cannot be reached. Same rule as every other message here.

   ⚠ IT ECHOES THE MESSAGE BACK, which the others do not. A contact form is the
   one place somebody types something long and then wonders whether it arrived
   at all — showing it back is the proof, and it gives them a copy they can
   forward or reply to. It is ESCAPED like everything else: this text came
   straight off a public form. */

/* ⚠ A long message would otherwise fill an inbox preview and push the reply
   promise below the fold. The full text is in the CMS either way, and they
   have their own copy of what they sent. */
const MAX_ECHO = 600;

const trim = (value = "") => {
  const text = String(value).trim();
  return text.length > MAX_ECHO ? `${text.slice(0, MAX_ECHO)}…` : text;
};

/**
 * The values the tokens are filled with. Exported so the Resend template path
 * sends the same set under the same names.
 */
export function contactValues({ name = "", subject = "", message = "" } = {}) {
  return {
    FIRST_NAME: String(name).trim().split(/\s+/)[0] ?? "",
    /* ⚠ NEVER EMPTY — a Resend Template has no conditionals, so an empty value
       renders as a bare label with nothing beside it. */
    SUBJECT: subject || "Your message",
    MESSAGE: trim(message) || "(no message was typed)",
    SENT_ON: new Date().toISOString().slice(0, 10),
  };
}

/**
 * @returns {{subject: string, html: string, text: string}}
 */
export function renderContactConfirmation({
  name = "",
  subject = "",
  message = "",
  siteUrl = "",
  country = "in",
  brandName = "Iwan Community",
} = {}) {
  const values = contactValues({ name, subject, message });
  const greeting = values.FIRST_NAME ? `Hi ${values.FIRST_NAME},` : "Hi,";
  const mailSubject = "We have your message";

  /* ⚠ The designed file in templates/ — the SAME one uploaded to Resend, so
     the fallback and the Template render identically. */
  let html = render(
    `contact-${country === "ca" ? "ca" : "in"}.html`,
    lower({ ...values, site_url: siteUrl })
  );

  /* ⚠ Same rule as the unsubscribe row: no address to point at means DROP the
     button, not render one that goes nowhere. */
  if (!siteUrl) html = dropSection(html, "CTA");

  const text = [
    greeting,
    "",
    "Thank you for writing to us. Someone reads every message, and we will reply as soon as we can.",
    "",
    `Sent:    ${values.SENT_ON}`,
    `Subject: ${values.SUBJECT}`,
    "",
    values.MESSAGE,
    "",
    siteUrl && "",
    siteUrl && `See what's on: ${siteUrl}`,
    "",
    /* ⚠ "Team Iwan", not the brand name — it matches how the designed
       templates sign off, and a person reads one immediately after the other.
       `brandName` still names the organisation in the sentences ABOUT it. */
    "— Team Iwan",
  ]
    .filter((line) => line !== false && line !== undefined)
    .join("\n");

  return { subject: mailSubject, html, text };
}

export default renderContactConfirmation;
