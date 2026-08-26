/* The confirmation someone gets after registering for an event.

   ⚠ THIS FILE IS THE ONE PLACE HEX COLOURS BELONG. The site forbids them in
   src/ because Tailwind is its source of truth — but an email has no Tailwind,
   no stylesheet and no build step. Every colour has to be written inline, on
   the element, or mail clients drop it. The values below are copied from the
   site's `ocean` theme in tailwind.config.js; change them there first.

   ⚠ TABLES, NOT DIVS, and inline styles rather than a <style> block. Outlook
   renders through Word's HTML engine, which has no flexbox, no grid and
   unreliable float support. Gmail strips <head> styles when it clips a long
   message. Table layout with inline attributes is the only thing that renders
   the same in Outlook, Gmail, Apple Mail and everything older. */

const BRAND = {
  primary: "#244967",
  primaryDark: "#1b374e",
  accent: "#f9be00",
  ink: "#0a1020",
  muted: "#5b6b80",
  line: "#e4e8f0",
  mist: "#f7f9fc",
  white: "#ffffff",
};

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'DM Sans', Roboto, Helvetica, Arial, sans-serif";

/* ⚠ Everything interpolated below comes from a public form or from CMS copy.
   Without escaping, a person registering as `<script>…` would have it rendered
   by whatever client opens the message. */
export const escapeHtml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/* One label/value row in the details block. */
const detailRow = (label, value) => `
              <tr>
                <td style="padding:0 0 14px 0;font-family:${FONT};font-size:13px;line-height:18px;color:${BRAND.muted};font-weight:700;text-transform:uppercase;letter-spacing:0.08em;width:74px;vertical-align:top;">${escapeHtml(label)}</td>
                <td style="padding:0 0 14px 0;font-family:${FONT};font-size:15px;line-height:22px;color:${BRAND.ink};font-weight:600;vertical-align:top;">${escapeHtml(value)}</td>
              </tr>`;

/**
 * Renders the confirmation.
 *
 * Every field is optional except the event title — an event with no venue or
 * no stated time simply drops that row rather than printing an empty one.
 *
 * @returns {{subject: string, html: string, text: string}}
 */
export function renderRegistrationConfirmation({
  name = "",
  eventTitle = "",
  when = "",
  where = "",
  eventUrl = "",
  brandName = "Iwan Community",
} = {}) {
  const greeting = name ? `Hi ${name},` : "Hi,";
  const subject = `You're registered: ${eventTitle}`;

  /* ⚠ The preheader is the grey line a client previews next to the subject.
     Left unset, clients scrape the first text they find — here that would be
     the brand name in the header bar, which tells the reader nothing. */
  const preheader = `Your place at ${eventTitle} is confirmed.`;

  const rows = [when && detailRow("When", when), where && detailRow("Where", where)]
    .filter(Boolean)
    .join("");

  /* ⚠ Outlook ignores padding on <a>, so the button needs a table cell to give
     it a hit area and a background. */
  const button = eventUrl
    ? `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 0 0;">
              <tr>
                <td align="center" bgcolor="${BRAND.primary}" style="border-radius:6px;">
                  <a href="${escapeHtml(eventUrl)}" target="_blank" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;font-weight:700;color:${BRAND.white};text-decoration:none;border-radius:6px;">Event details</a>
                </td>
              </tr>
            </table>`
    : "";

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.mist};">
<div style="display:none;font-size:1px;color:${BRAND.mist};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(preheader)}</div>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${BRAND.mist};">
  <tr>
    <td align="center" style="padding:32px 16px;">

      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:100%;background-color:${BRAND.white};border-radius:8px;overflow:hidden;border:1px solid ${BRAND.line};">

        <tr>
          <td style="background-color:${BRAND.primary};padding:22px 32px;">
            <span style="font-family:${FONT};font-size:15px;font-weight:800;color:${BRAND.white};letter-spacing:0.04em;">${escapeHtml(brandName)}</span>
          </td>
        </tr>

        <tr>
          <td style="height:4px;background-color:${BRAND.accent};font-size:0;line-height:0;">&nbsp;</td>
        </tr>

        <tr>
          <td style="padding:34px 32px 8px 32px;">
            <h1 style="margin:0 0 6px 0;font-family:${FONT};font-size:24px;line-height:31px;font-weight:800;color:${BRAND.ink};">You're registered</h1>
            <p style="margin:0 0 20px 0;font-family:${FONT};font-size:16px;line-height:24px;color:${BRAND.muted};">${escapeHtml(greeting)}</p>
            <p style="margin:0 0 22px 0;font-family:${FONT};font-size:16px;line-height:24px;color:${BRAND.ink};">Your place at <strong style="color:${BRAND.ink};">${escapeHtml(eventTitle)}</strong> is confirmed. We look forward to seeing you.</p>
          </td>
        </tr>
${
  rows
    ? `
        <tr>
          <td style="padding:0 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${BRAND.mist};border:1px solid ${BRAND.line};border-radius:6px;">
              <tr><td style="padding:20px 22px 6px 22px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
${rows}
                </table>
              </td></tr>
            </table>
          </td>
        </tr>`
    : ""
}
        <tr>
          <td style="padding:22px 32px 34px 32px;">
${button}
            <p style="margin:22px 0 0 0;font-family:${FONT};font-size:14px;line-height:21px;color:${BRAND.muted};">Can no longer make it? Just reply to this email and let us know, so we can offer your place to someone else.</p>
          </td>
        </tr>

        <tr>
          <td style="background-color:${BRAND.mist};border-top:1px solid ${BRAND.line};padding:18px 32px;">
            <p style="margin:0;font-family:${FONT};font-size:12px;line-height:18px;color:${BRAND.muted};">You are receiving this because you registered for an event with ${escapeHtml(brandName)}.</p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  /* ⚠ The plain-text part is not optional. Some clients render only text, and
     a message with no text/plain alternative scores worse with spam filters. */
  const text = [
    greeting,
    "",
    `Your place at ${eventTitle} is confirmed. We look forward to seeing you.`,
    "",
    when && `When:  ${when}`,
    where && `Where: ${where}`,
    eventUrl && `Details: ${eventUrl}`,
    "",
    "Can no longer make it? Just reply to this email and let us know, so we can offer your place to someone else.",
    "",
    `— ${brandName}`,
  ]
    .filter((line) => line !== false && line !== undefined)
    .join("\n");

  return { subject, html, text };
}

export default renderRegistrationConfirmation;
