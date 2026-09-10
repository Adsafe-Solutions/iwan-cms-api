/* The confirmation someone gets after registering for an event.

   ⚠ THE ONE PLACE HEX COLOURS BELONG. An email has no Tailwind and no build
   step, so colours must be inline or clients drop them. The values are copied
   from the site's `ocean` theme; change them there first.

   ⚠ TABLES, NOT DIVS, and inline styles rather than a <style> block. Outlook
   renders through Word's engine (no flexbox, no grid) and Gmail strips <head>
   styles when it clips a message. */

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

/* ⚠ Everything interpolated below comes from a public form. Without escaping,
   someone registering as `<script>…` gets it rendered by the mail client. */
export const escapeHtml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const detailRow = (label, value) => `
              <tr>
                <td style="padding:0 0 14px 0;font-family:${FONT};font-size:13px;line-height:18px;color:${BRAND.muted};font-weight:700;text-transform:uppercase;letter-spacing:0.08em;width:74px;vertical-align:top;">${escapeHtml(label)}</td>
                <td style="padding:0 0 14px 0;font-family:${FONT};font-size:15px;line-height:22px;color:${BRAND.ink};font-weight:600;vertical-align:top;">${escapeHtml(value)}</td>
              </tr>`;

/**
 * Renders the confirmation. Every field is optional except the event title; a
 * missing venue or time drops its row rather than printing an empty one.
 *
 * @returns {{subject: string, html: string, text: string}}
 */
export function renderRegistrationConfirmation({
  unsubscribeUrl = "",
  name = "",
  eventTitle = "",
  when = "",
  where = "",
  eventUrl = "",
  brandName = "Iwan Community",
} = {}) {
  const greeting = name ? `Hi ${name},` : "Hi,";
  const subject = `You're registered: ${eventTitle}`;

  /* ⚠ The grey preview line beside the subject. Left unset, clients scrape the
     first text they find — here the brand name, which says nothing. */
  const preheader = `Your spot at ${eventTitle} is confirmed.`;

  const rows = [when && detailRow("When", when), where && detailRow("Where", where)]
    .filter(Boolean)
    .join("");

  /* ⚠ Outlook ignores padding on <a>, so the button needs a table cell. */
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
            <p style="margin:0 0 22px 0;font-family:${FONT};font-size:16px;line-height:24px;color:${BRAND.ink};">Your spot at <strong style="color:${BRAND.ink};">${escapeHtml(eventTitle)}</strong> is confirmed. We look forward to seeing you.</p>
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
            <p style="margin:22px 0 0 0;font-family:${FONT};font-size:14px;line-height:21px;color:${BRAND.muted};">Can no longer make it? Just reply to this email and let us know, so we can offer your spot to someone else.</p>
          </td>
        </tr>

        <tr>
          <td style="background-color:${BRAND.mist};border-top:1px solid ${BRAND.line};padding:18px 32px;">
            <p style="margin:0;font-family:${FONT};font-size:12px;line-height:18px;color:${BRAND.muted};">You are receiving this because you registered for an event with ${escapeHtml(brandName)}.${
              unsubscribeUrl
                ? ` <a href="${escapeHtml(unsubscribeUrl)}" style="color:${BRAND.muted};text-decoration:underline;">Unsubscribe from our newsletter</a>.`
                : ""
            }</p>${
              unsubscribeUrl
                ? `
            <p style="margin:8px 0 0 0;font-family:${FONT};font-size:12px;line-height:18px;color:${BRAND.muted};">Unsubscribing does not cancel your place at an event.</p>`
                : ""
            }
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

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
    `— ${brandName}`,
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
