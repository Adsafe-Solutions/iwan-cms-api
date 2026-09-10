import { escapeHtml } from "./registration.js";

/* The "you're on the list" email, sent once when somebody subscribes.

   ⚠ SAME CONSTRAINTS AS registration.js — tables not divs, inline styles, hex
   colours — and the same palette, deliberately: someone who registered for an
   event last week and subscribes today should recognise both as Iwan.

   ⚠ THIS ONE IS MARKETING, not transactional. It is the message that starts a
   mailing relationship, so the unsubscribe link is NOT optional here the way it
   is on a booking confirmation — it is the first thing that makes the list
   honest. mail.js refuses to send this without one. */

const BRAND = {
  primary: "#244967",
  accent: "#f9be00",
  ink: "#0a1020",
  muted: "#5b6b80",
  line: "#e4e8f0",
  mist: "#f7f9fc",
  white: "#ffffff",
};

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'DM Sans', Roboto, Helvetica, Arial, sans-serif";

/**
 * @returns {{subject: string, html: string, text: string}}
 */
export function renderSubscribeWelcome({
  name = "",
  unsubscribeUrl = "",
  siteUrl = "",
  brandName = "Iwan Community",
} = {}) {
  const greeting = name ? `Hi ${name},` : "Hi,";
  const subject = `You're subscribed to ${brandName}`;
  const preheader = "You'll hear from us when there is something worth saying.";

  const button = siteUrl
    ? `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 0 0;">
              <tr>
                <td align="center" bgcolor="${BRAND.primary}" style="border-radius:6px;">
                  <a href="${escapeHtml(siteUrl)}" target="_blank" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;font-weight:700;color:${BRAND.white};text-decoration:none;border-radius:6px;">See what's on</a>
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
            <h1 style="margin:0 0 6px 0;font-family:${FONT};font-size:24px;line-height:31px;font-weight:800;color:${BRAND.ink};">You're on the list</h1>
            <p style="margin:0 0 20px 0;font-family:${FONT};font-size:16px;line-height:24px;color:${BRAND.muted};">${escapeHtml(greeting)}</p>
            <p style="margin:0 0 22px 0;font-family:${FONT};font-size:16px;line-height:24px;color:${BRAND.ink};">Thank you for subscribing. We will write when there is an event worth coming to or something worth reading — not otherwise.</p>
          </td>
        </tr>

        <tr>
          <td style="padding:0 32px 34px 32px;">
${button}
          </td>
        </tr>

        <tr>
          <td style="background-color:${BRAND.mist};border-top:1px solid ${BRAND.line};padding:18px 32px;">
            <p style="margin:0;font-family:${FONT};font-size:12px;line-height:18px;color:${BRAND.muted};">You are receiving this because you subscribed at ${escapeHtml(brandName)}. <a href="${escapeHtml(unsubscribeUrl)}" style="color:${BRAND.muted};text-decoration:underline;">Unsubscribe</a>.</p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const text = [
    greeting,
    "",
    "Thank you for subscribing. We will write when there is an event worth coming to or something worth reading — not otherwise.",
    "",
    siteUrl && `See what's on: ${siteUrl}`,
    "",
    `— ${brandName}`,
    "",
    `Unsubscribe: ${unsubscribeUrl}`,
  ]
    .filter((line) => line !== false && line !== undefined)
    .join("\n");

  return { subject, html, text };
}

export default renderSubscribeWelcome;
