import { escapeHtml } from "./registration.js";

/* The heads-up Iwan gets when someone fills in a form — a registration, a
   message, an application, a subscription.

   ⚠ NOT the same thing as the registration confirmation next door. That one
   goes OUTWARD to the person and is the organisation's public face, so it is
   branded and carefully worded. This one goes to Iwan's own inbox, so it is
   built to be READ FAST and replied to: who, what, and every answer, with no
   marketing furniture in the way.

   ⚠ Same table-and-inline-styles rules as registration.js — Outlook renders
   through Word, and Gmail strips <head> styles when it clips a message. */

const BRAND = {
  primary: "#244967",
  ink: "#0a1020",
  muted: "#5b6b80",
  line: "#e4e8f0",
  mist: "#f7f9fc",
  white: "#ffffff",
};

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'DM Sans', Roboto, Helvetica, Arial, sans-serif";

/* An answer's value can be a string, a {first,last}, an array or a boolean —
   the same spread the CSV export flattens. Rendered the same way here so the
   two never disagree about what an answer said. */
const readable = (value) => {
  if (value === null || value === undefined || value === "") return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") {
    return [value.first, value.last].filter(Boolean).join(" ");
  }
  return String(value);
};

const row = (label, value) => `
              <tr>
                <td style="padding:0 16px 12px 0;font-family:${FONT};font-size:12px;line-height:18px;color:${BRAND.muted};font-weight:700;text-transform:uppercase;letter-spacing:0.07em;white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>
                <td style="padding:0 0 12px 0;font-family:${FONT};font-size:15px;line-height:22px;color:${BRAND.ink};vertical-align:top;white-space:pre-wrap;">${escapeHtml(value)}</td>
              </tr>`;

/**
 * One notification. `rows` is [label, value] pairs, in the order they should
 * be read — a blank value drops its row rather than printing an empty one.
 *
 * @returns {{subject: string, html: string, text: string}}
 */
export function renderNotification({
  subject = "New form submission",
  heading = "",
  intro = "",
  rows = [],
  cmsUrl = "",
  cmsLabel = "Open the CMS",
} = {}) {
  const pairs = rows
    .map(([label, value]) => [label, readable(value)])
    .filter(([, value]) => value !== "");

  const button = cmsUrl
    ? `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 0 0;">
              <tr>
                <td style="background-color:${BRAND.primary};border-radius:6px;">
                  <a href="${escapeHtml(cmsUrl)}" style="display:inline-block;padding:11px 22px;font-family:${FONT};font-size:14px;font-weight:700;color:${BRAND.white};text-decoration:none;">${escapeHtml(cmsLabel)}</a>
                </td>
              </tr>
            </table>`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.mist};">
<span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;">${escapeHtml(intro || heading)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND.mist};padding:24px 12px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:${BRAND.white};border:1px solid ${BRAND.line};border-radius:10px;">

        <tr>
          <td style="padding:26px 30px 6px 30px;">
            <p style="margin:0 0 6px 0;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:${BRAND.muted};">iwan.community</p>
            <h1 style="margin:0;font-family:${FONT};font-size:21px;line-height:28px;color:${BRAND.ink};font-weight:800;">${escapeHtml(heading)}</h1>
            ${intro ? `<p style="margin:10px 0 0 0;font-family:${FONT};font-size:14px;line-height:21px;color:${BRAND.muted};">${escapeHtml(intro)}</p>` : ""}
          </td>
        </tr>

        <tr>
          <td style="padding:20px 30px 4px 30px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${pairs.map(([label, value]) => row(label, value)).join("")}
            </table>
          </td>
        </tr>

        ${button ? `<tr><td style="padding:6px 30px 26px 30px;">${button}</td></tr>` : `<tr><td style="padding:0 30px 20px 30px;"></td></tr>`}

        <tr>
          <td style="background-color:${BRAND.mist};border-top:1px solid ${BRAND.line};padding:14px 30px;border-radius:0 0 10px 10px;">
            <p style="margin:0;font-family:${FONT};font-size:12px;line-height:18px;color:${BRAND.muted};">Sent automatically when someone submits a form on iwan.community.</p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const text = [
    heading,
    intro,
    "",
    ...pairs.map(([label, value]) => `${label}: ${value}`),
    "",
    cmsUrl && `${cmsLabel}: ${cmsUrl}`,
  ]
    .filter((line) => line !== undefined && line !== false)
    .join("\n")
    .trim();

  return { subject, html, text };
}

export default renderNotification;
