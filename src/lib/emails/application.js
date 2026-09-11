import { dropSection, lower, render } from "./render.js";

/* "We have your application" — the volunteer and career equivalent of the
   registration confirmation.

   ⚠ RESEND'S TEMPLATE WINS WHERE THERE IS ONE, under
   `iwan-application-{in,ca}`; this renders when there is no published one, or
   Resend cannot be reached. Same rule as the confirmation — see
   lib/templates.js.

   ⚠ ONE TEMPLATE FOR BOTH KINDS, with the kind as a value. A volunteer offer
   and a job application get the same acknowledgement in different words, and
   two near-identical templates would drift apart the first time one was
   edited. */

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
  country = "in",
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
  /* ⚠ The designed file in templates/ — the SAME one uploaded to Resend, so
     the fallback and the Template render identically. */
  let html = render(
    `application-${country === "ca" ? "ca" : "in"}.html`,
    lower({ ...values, site_url: siteUrl })
  );

  /* ⚠ Same rule as the unsubscribe row: no address to point at means DROP the
     button, not render one that goes nowhere. */
  if (!siteUrl) html = dropSection(html, "CTA");

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

  return { subject, html, text };
}

export default renderApplicationConfirmation;
