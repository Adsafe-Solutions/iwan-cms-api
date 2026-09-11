import { dropSection, lower, render } from "./render.js";
/* The confirmation someone gets after registering for an event.

   ⚠ RESEND'S TEMPLATE WINS WHERE THERE IS ONE. The files in templates/ are
   what gets uploaded there, and
   lib/templates.js uses one whenever a published one exists. This renders only
   when Resend has none, or cannot be reached: a plainer confirmation is worth
   sending, and an account with no templates yet still works.

  

   ⚠ THE ONE PLACE HEX COLOURS BELONG. An email has no Tailwind and no build
   step, so colours must be inline or clients drop them. The values are copied
   from the site's `ocean` theme; change them there first.

   ⚠ TABLES, NOT DIVS, and inline styles rather than a <style> block. Outlook
   renders through Word's engine (no flexbox, no grid) and Gmail strips <head>
   styles when it clips a message. */

/* Matches the site's own `lib/map.js`, deliberately: the email and the page
   must pin the same place. Coordinates win where an event has them, otherwise
   the venue text, and the address is the last resort. */
export const directionsUrl = (event = {}) => {
  const query =
    Array.isArray(event.coords) && event.coords.length === 2
      ? event.coords.join(",")
      : event.venue || event.address || "";
  return query
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
    : "";
};

/* ⚠ The photograph in the designed template is THE EVENT'S OWN, so a person
   sees the thing they registered for rather than a stock crowd. An event
   without one falls back to the hero the template shipped with — a template
   variable that arrives empty renders as a broken image, and Resend refuses a
   send outright when a declared variable has neither value nor fallback. */
export const DEFAULT_EVENT_IMAGE = "https://cdn.iwan.community/iwan-youth-hero.webp";

/* ⚠ FIRST name only. The designed template greets with it — "Assalamu alaikum
   Aisha" — and a full name there reads like a letter from a bank. */
export const firstNameOf = (name = "") => String(name).trim().split(/\s+/)[0] ?? "";

/**
 * The values a confirmation is built from, in ONE place — this file renders
 * them, and lib/mail.js sends the same set (lower-cased) to a Resend template.
 * One definition, so the two cannot drift.
 */
export function registrationValues({
  name = "",
  event = {},
  eventTitle = "",
  eventUrl = "",
  unsubscribeUrl = "",
} = {}) {
  return {
    FIRST_NAME: firstNameOf(name),
    EVENT_TITLE: event.title || eventTitle,
    EVENT_DATE: event.date ?? "",
    EVENT_START: event.start ?? "",
    EVENT_END: event.end ?? "",
    EVENT_VENUE: [event.venue, event.address].filter(Boolean).join(", "),
    EVENT_URL: eventUrl,
    EVENT_IMAGE: event.img || DEFAULT_EVENT_IMAGE,
    DIRECTIONS_URL: directionsUrl(event),
    UNSUBSCRIBE_URL: unsubscribeUrl,
  };
}

/**
 * Renders the confirmation. Every field is optional except the event title; a
 * missing venue or time drops its row rather than printing an empty one.
 *
 * @returns {{subject: string, html: string, text: string}}
 */
export function renderRegistrationConfirmation({
  /* The same shape the Resend template path builds — see registrationValues. */
  name = "",
  event = {},
  eventTitle = "",
  eventUrl = "",
  unsubscribeUrl = "",
  /* ⚠ Picks the designed FILE — Canada's links are country-prefixed and its
     address and social accounts are its own. An unknown country falls back to
     India's rather than failing to send at all. */
  country = "in",
  /* ⚠ Gates the unsubscribe LINE IN THE TEXT ALTERNATIVE only. The designed
     HTML shows its block to everybody, because Resend Templates have no
     conditionals and the same file is rendered on both sides — what stops it
     leading nowhere is an empty `unsubscribe_url`, which the renderer drops
     the row for. */
  subscribed = false,
  brandName = "Iwan Community",
} = {}) {
  const values = registrationValues({
    name,
    event,
    eventTitle,
    eventUrl,
    unsubscribeUrl,
  });

  eventTitle = values.EVENT_TITLE;
  const when = [
    values.EVENT_DATE,
    [values.EVENT_START, values.EVENT_END].filter(Boolean).join("–"),
  ]
    .filter(Boolean)
    .join(", ");
  const where = values.EVENT_VENUE;
  eventUrl = values.EVENT_URL;
  unsubscribeUrl = subscribed ? values.UNSUBSCRIBE_URL : "";

  const greeting = values.FIRST_NAME ? `Hi ${values.FIRST_NAME},` : "Hi,";
  const subject = `You're registered: ${eventTitle}`;

  /* ⚠ The grey preview line beside the subject. Left unset, clients scrape the
     first text they find — here the brand name, which says nothing. */
  const preheader = `Your spot at ${eventTitle} is confirmed.`;

  /* ⚠ The designed file in templates/ — the SAME one uploaded to Resend, so
     the fallback and the Template render identically. */
  let html = render(`registration-${country === "ca" ? "ca" : "in"}.html`, lower(values));

  /* ⚠ No link means DROP THE ROW, not render an empty one — see dropSection.
     With API_URL unset there is nothing to point at, and a button leading
     nowhere is worse than no button. */
  if (!values.UNSUBSCRIBE_URL) html = dropSection(html, "UNSUBSCRIBE");

  /* ⚠ Same rule as the unsubscribe row: no address to point at means DROP the
     button, not render one that goes nowhere. */
  if (!values.EVENT_URL) html = dropSection(html, "CTA");

  /* ⚠ And the directions button, which has its own row and its own URL: an
     event with no venue, address or coordinates has nowhere to send anybody. */
  if (!values.DIRECTIONS_URL) html = dropSection(html, "DIRECTIONS");

  /* ⚠ Not optional: some clients render only text, and a message without a
     text/plain alternative scores worse with spam filters. */
  const text = [
    greeting,
    "",
    `Your spot at ${eventTitle} is confirmed. We look forward to seeing you.`,
    "",
    when && `When:  ${when}`,
    where && `Where: ${where}`,
    eventUrl && `Details: ${eventUrl}`,
    "",
    "Can no longer make it? Just reply to this email and let us know, so we can offer your spot to someone else.",
    "",
    /* ⚠ "Team Iwan", not the brand name — it matches how the designed
       templates sign off, and a person reads one immediately after the other.
       `brandName` still names the organisation in the sentences ABOUT it. */
    "— Team Iwan",
    /* ⚠ In the text alternative too, and spread rather than filtered: a client
       rendering text only would otherwise show a message with no way off the
       list at all. Blank lines are meaningful here, so the pair goes in
       together or not at all. */
    ...(unsubscribeUrl
      ? [
          "",
          `Unsubscribe from our newsletter: ${unsubscribeUrl}`,
          "(This does not cancel your place at an event.)",
        ]
      : []),
  ]
    .filter((line) => line !== false && line !== undefined)
    .join("\n");

  return { subject, html, text };
}

export default renderRegistrationConfirmation;
