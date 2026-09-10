import { escapeHtml } from "./registration.js";

/* "We have your application" — the volunteer and career equivalent of the
   registration confirmation.

   ⚠ THE FALLBACK, NOT THE DESIGN. The designed templates live in Resend under
   `iwan-application-{in,ca}`; this renders when there is no published one, or
   Resend cannot be reached. Same rule as the confirmation — see
   lib/templates.js.

   ⚠ ONE TEMPLATE FOR BOTH KINDS, with the kind as a value. A volunteer offer
   and a job application get the same acknowledgement in different words, and
   two near-identical templates would drift apart the first time one was
   edited. */

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

/* ⚠ What each kind is CALLED, in one place. The wording reaches the subject
   line, the body and the Resend template's `application_type`, and the three
   disagreeing is exactly the kind of thing nobody notices until a person
   replies asking which one they applied for. */
export const APPLICATION_WORDING = {
  volunteer: {
    label: "volunteering",
    heading: "Thank you for offering to help",
    intro: "Thank you — we have your volunteering application.",
    /* ⚠ What fills `role` when the form did not ask for one. It CANNOT be
       empty: a Resend Template has no conditionals, so an empty value renders
       as a bare label with nothing beside it. */
    role: "Wherever help is needed",
  },
  career: {
    /* ⚠ "job", not "role" — the word lands in "your ___ application" and in the
       footer's "you sent us a ___ application", and "your role application" is
       not English. Read it in the sentence before changing it. */
    label: "job",
    heading: "We have your application",
    intro: "Thank you — we have your application.",
    role: "Any suitable role",
  },
};

/**
 * The values the tokens are filled with. Exported so the Resend template path
 * in lib/mail.js sends the same set under the same names.
 */
export function applicationValues({
  kind = "volunteer",
  name = "",
  role = "",
  submittedOn = new Date(),
} = {}) {
  const words = APPLICATION_WORDING[kind] ?? APPLICATION_WORDING.volunteer;
  return {
    FIRST_NAME: String(name).trim().split(/\s+/)[0] ?? "",
    APPLICATION_TYPE: words.label,
    /* ⚠ NEVER EMPTY — see the wording table. Only the career form asks for a
       role, and the designed template shows the row unconditionally. */
    ROLE: role || words.role,
    /* ⚠ A day string, not a timestamp, and the same format the rest of this
       API uses: an application was made on a calendar day, and an ISO instant
       here would be read in the wrong timezone by whoever opens it. */
    SUBMITTED_ON: new Date(submittedOn).toISOString().slice(0, 10),
  };
}

/**
 * @returns {{subject: string, html: string, text: string}}
 */
export function renderApplicationConfirmation({
  kind = "volunteer",
  name = "",
  role = "",
  siteUrl = "",
  brandName = "Iwan Community",
} = {}) {
  const words = APPLICATION_WORDING[kind] ?? APPLICATION_WORDING.volunteer;
  const values = applicationValues({ kind, name, role });

  const greeting = values.FIRST_NAME ? `Hi ${values.FIRST_NAME},` : "Hi,";
  const subject =
    kind === "career" ? "We have your application" : "Thank you for offering to help";

  /* ⚠ NO UNSUBSCRIBE LINK AND NO List-Unsubscribe HEADER on this one. It is
     transactional in the strictest sense — a reply to something the person
     just sent — and applying for a role is not joining a mailing list. Anyone
     who ticked the newsletter box on the same form gets the welcome separately,
     and that one carries its own. */
  /* The same three facts the designed template shows in its panel. */
  const row = (label, value) => `
                <tr>
                  <td style="padding:0 0 12px 0;font-family:${FONT};font-size:12px;line-height:18px;color:${BRAND.muted};font-weight:700;text-transform:uppercase;letter-spacing:0.08em;width:110px;vertical-align:top;">${escapeHtml(label)}</td>
                  <td style="padding:0 0 12px 0;font-family:${FONT};font-size:15px;line-height:22px;color:${BRAND.ink};font-weight:600;vertical-align:top;">${escapeHtml(value)}</td>
                </tr>`;

  const details = `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${BRAND.mist};border:1px solid ${BRAND.line};border-radius:8px;margin:0 0 20px 0;">
              <tr><td style="padding:20px 22px 8px 22px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
${row("Application", values.APPLICATION_TYPE)}
${row("Interested in", values.ROLE)}
${row("Received", values.SUBMITTED_ON)}
                </table>
              </td></tr>
            </table>`;

  const button = siteUrl
    ? `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 0 0;">
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
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.mist};">
<div style="display:none;font-size:1px;color:${BRAND.mist};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(words.intro)}</div>

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
          <td style="padding:34px 32px 34px 32px;">
            <h1 style="margin:0 0 6px 0;font-family:${FONT};font-size:24px;line-height:31px;font-weight:800;color:${BRAND.ink};">${escapeHtml(words.heading)}</h1>
            <p style="margin:0 0 20px 0;font-family:${FONT};font-size:16px;line-height:24px;color:${BRAND.muted};">${escapeHtml(greeting)}</p>
            <p style="margin:0 0 18px 0;font-family:${FONT};font-size:16px;line-height:24px;color:${BRAND.ink};">${escapeHtml(words.intro)}</p>
${details}
            <p style="margin:0 0 14px 0;font-family:${FONT};font-size:15px;line-height:23px;color:${BRAND.muted};"><strong style="color:${BRAND.ink};">What happens next.</strong> Someone reads every application properly. If it looks like a fit we will write to arrange a conversation — usually within two weeks. We do not always manage to reply to each one, but nothing is discarded.</p>
            <p style="margin:0 0 22px 0;font-family:${FONT};font-size:15px;line-height:23px;color:${BRAND.muted};">Anything to add — a portfolio, a CV, dates you are away — just reply to this email and it reaches the same place.</p>
${button}
          </td>
        </tr>

        <tr>
          <td style="background-color:${BRAND.mist};border-top:1px solid ${BRAND.line};padding:18px 32px;">
            <p style="margin:0;font-family:${FONT};font-size:12px;line-height:18px;color:${BRAND.muted};">You are receiving this because you sent us a ${escapeHtml(values.APPLICATION_TYPE)} application at ${escapeHtml(brandName)}.</p>
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
    words.intro,
    "",
    `Application:   ${values.APPLICATION_TYPE}`,
    `Interested in: ${values.ROLE}`,
    `Received:      ${values.SUBMITTED_ON}`,
    "",
    "What happens next. Someone reads every application properly. If it looks like a fit we will write to arrange a conversation — usually within two weeks. We do not always manage to reply to each one, but nothing is discarded.",
    "",
    "Anything to add — a portfolio, a CV, dates you are away — just reply to this email and it reaches the same place.",
    siteUrl && "",
    siteUrl && `See what's on: ${siteUrl}`,
    "",
    `— ${brandName}`,
  ]
    .filter((line) => line !== false && line !== undefined)
    .join("\n");

  return { subject, html, text };
}

export default renderApplicationConfirmation;
