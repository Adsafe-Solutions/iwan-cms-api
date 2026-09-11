/* Renders every email this API can send, so they can be read without waiting
   for a form submission — and optionally sends them to a real inbox.

     npm run mail:preview                     # writes HTML files, opens nothing
     npm run mail:preview -- --to=you@x.com   # ALSO sends them, for real

   ⚠ NO DATABASE AND NO KEY NEEDED for the default run. It renders the BUILT-IN
   messages — the fallbacks — which is exactly what goes out when Resend has no
   published template. What it cannot show is a Resend Template: that lives on
   their side and is rendered by them, so the only way to see one is to send it
   or use the preview in Resend's own dashboard.

   ⚠ `--to` SENDS REAL EMAIL from the real account, and needs RESEND_API_KEY and
   MAIL_FROM in .env. It bypasses every guard the routes apply — no rate limit,
   no audience row, no once-ever rule — because it is a rendering check, not a
   test of the flow. */

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v = true] = a.replace(/^--/, "").split("=");
    return [k, v];
  })
);

const to = args.get("to");
const outDir = resolve(process.cwd(), ".mail-preview");

const { renderRegistrationConfirmation } =
  await import("../src/lib/emails/registration.js");
const { renderSubscribeWelcome } = await import("../src/lib/emails/subscribe.js");
const { renderApplicationConfirmation } =
  await import("../src/lib/emails/application.js");
const { renderContactConfirmation } = await import("../src/lib/emails/contact.js");

/* Plausible values rather than "test test test": the point is to see what a
   real one looks like, including how a long venue or a missing name lands. */
const EVENT = {
  title: "Asma ul Husna: As-Salam, the Source of Peace",
  date: "2026-08-21",
  start: "18:30",
  end: "21:00",
  venue: "Iwan Hall",
  address: "14 Main Street, Bangalore",
  img: "https://cdn.iwan.community/iwan-youth-hero.webp",
};

const UNSUB = "https://iwan-cms-api.vercel.app/api/unsubscribe?t=example-token";
const SITE = process.env.SITE_URL || "https://iwan.community";

const previews = [
  [
    "registration-subscribed",
    renderRegistrationConfirmation({
      name: "Aisha Rahman",
      event: EVENT,
      eventUrl: `${SITE}/events/asma-ul-husna`,
      unsubscribeUrl: UNSUB,
      subscribed: true,
    }),
  ],
  [
    "registration-not-subscribed",
    renderRegistrationConfirmation({
      name: "Aisha Rahman",
      event: EVENT,
      eventUrl: `${SITE}/events/asma-ul-husna`,
      unsubscribeUrl: UNSUB,
      subscribed: false,
    }),
  ],
  /* ⚠ No name — the greeting has to read properly without one, and this is the
     case nobody remembers to check. */
  [
    "registration-no-name",
    renderRegistrationConfirmation({ event: EVENT, subscribed: false }),
  ],
  [
    "subscribe-welcome",
    renderSubscribeWelcome({ name: "Aisha", unsubscribeUrl: UNSUB, siteUrl: SITE }),
  ],
  [
    "application-volunteer",
    renderApplicationConfirmation({
      kind: "volunteer",
      name: "Aisha Rahman",
      siteUrl: SITE,
    }),
  ],
  [
    "contact",
    renderContactConfirmation({
      name: "Aisha Rahman",
      subject: "Can I bring my sister to the gardening session?",
      message:
        "Assalamu alaikum,\n\nI came to the last one and my sister would like to join too. Is there room, and does she need to register separately?\n\nJazakallah khair.",
      siteUrl: SITE,
    }),
  ],
  [
    "application-career",
    renderApplicationConfirmation({
      kind: "career",
      name: "Omar Farouk",
      role: "Programme Coordinator",
      siteUrl: SITE,
    }),
  ],
];

mkdirSync(outDir, { recursive: true });

for (const [name, mail] of previews) {
  writeFileSync(resolve(outDir, `${name}.html`), mail.html);
  /* ⚠ The text alternative is written too. Some clients render only that, and
     it is the half nobody looks at until it ships wrong. */
  writeFileSync(resolve(outDir, `${name}.txt`), mail.text);
}

console.log(`
  ${previews.length} messages written to .mail-preview/

${previews.map(([n, m]) => `    ${n.padEnd(28)} ${m.subject}`).join("\n")}

  Open them:  xdg-open .mail-preview/registration-subscribed.html
`);

if (!to) process.exit(0);

/* ── sending, for real ───────────────────────────────────────────────────── */

const { CONFIG } = await import("../src/config.js");

if (!CONFIG.resendApiKey || !CONFIG.mailFrom) {
  console.error("  --to needs RESEND_API_KEY and MAIL_FROM in .env. Nothing was sent.\n");
  process.exit(1);
}

const { resend } = await import("../src/lib/resendClient.js");

for (const [name, mail] of previews) {
  const { error } = await resend.emails.send({
    from: CONFIG.mailFrom,
    to: [to],
    /* ⚠ Prefixed so six of these in an inbox can be told apart, and so nobody
       mistakes one for a real confirmation. */
    subject: `[preview: ${name}] ${mail.subject}`,
    html: mail.html,
    text: mail.text,
  });

  console.log(`    ${error ? "✗" : "✓"} ${name}${error ? `  ${error.message}` : ""}`);

  /* ⚠ Resend allows 10 requests a second per team; six sends in a burst is
     within that, but the pause costs nothing and keeps this well clear. */
  await new Promise((done) => setTimeout(done, 250));
}

console.log("");
