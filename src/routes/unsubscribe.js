import { Router } from "express";
import { Audience } from "../models/Audience.js";
import { readUnsubscribe } from "../lib/tokens.js";
import { mirrorContact } from "../lib/contacts.js";
import { wrap } from "../lib/errors.js";

/* The unsubscribe link in a transactional email.

   ⚠ THIS EXISTS BECAUSE RESEND WILL NOT DO IT HERE. Resend hosts the whole
   flow — link, page, contact update — for BROADCASTS and AUTOMATIONS, and
   routes/webhooks.js already syncs the result back. It does none of it for
   `emails.send`, which is what every message this API sends is: "Resend doesn't
   manage contact lists for transactional emails". So the confirmation's link
   lands here instead, and this has to do the same three things Resend's page
   does — record it, say so, and tell the other side.

   ⚠ NO SIGN-IN AND NO RATE LIMIT, on purpose. The token IS the authorisation,
   the action is idempotent, and the one-click POST arrives from Gmail's or
   Apple's servers rather than the person — a per-address limiter would refuse
   the mail provider, not an abuser.

   ⚠ THE ONLY HTML THIS API RENDERS. It is self-contained: no stylesheet, no
   script, no image, nothing to fetch — so the response carries a CSP that
   forbids all three rather than relying on the app-wide one, which is off
   precisely because there was no HTML here until now. */

const router = Router();

/* Copied from the confirmation email's palette — see lib/emails/registration.js,
   which is where these belong. Someone arriving from that email should not
   think they have landed on a different organisation's page. */
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

/* ⚠ Nothing user-supplied reaches this page — the heading and message are
   chosen from the fixed set below, and the address is never echoed back. An
   address printed here would be reflected from a URL anyone can craft. */
const page = ({ title, heading, message }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.mist};">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${BRAND.mist};min-height:100vh;">
  <tr>
    <td align="center" style="padding:48px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="520" style="width:520px;max-width:100%;background:${BRAND.white};border:1px solid ${BRAND.line};border-radius:8px;overflow:hidden;">
        <tr><td style="background:${BRAND.primary};padding:20px 30px;">
          <span style="font-family:${FONT};font-size:15px;font-weight:800;color:${BRAND.white};letter-spacing:0.04em;">Iwan Community</span>
        </td></tr>
        <tr><td style="height:4px;background:${BRAND.accent};font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td style="padding:34px 30px 36px 30px;">
          <h1 style="margin:0 0 10px 0;font-family:${FONT};font-size:22px;line-height:29px;font-weight:800;color:${BRAND.ink};">${heading}</h1>
          <p style="margin:0;font-family:${FONT};font-size:16px;line-height:24px;color:${BRAND.muted};">${message}</p>
        </td></tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

const send = (res, status, body) =>
  res
    .status(status)
    .type("html")
    /* ⚠ Tighter than the app-wide policy, which is off: this page fetches
       nothing, so everything is denied outright and inline styles are the one
       exception it needs. */
    .set(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
    )
    /* An unsubscribe confirmation is nobody's search result. */
    .set("X-Robots-Tag", "noindex, nofollow")
    .set("Cache-Control", "no-store")
    .send(body);

/* Does the work for both verbs. ⚠ Returns whether the token was READABLE, not
   whether a row changed — unsubscribing someone who is already unsubscribed,
   or who is not in the audience at all, is a success. The person asked to stop
   receiving mail and they will; which rows moved is not their problem. */
async function unsubscribe(token) {
  const email = readUnsubscribe(token);
  if (!email) return false;

  await Audience.updateOne({ email }, { $set: { subscribed: false } });

  /* ⚠ Pushed to Resend too, or the two sides disagree the moment this is used:
     Resend would go on believing they are subscribed and the next broadcast
     would reach them. This is the mirror image of what webhooks.js does for an
     unsubscribe made on Resend's side. Not awaited — the person is unsubscribed
     here either way, and this page must not wait on a third party. */
  mirrorContact({ email, subscribed: false });

  return true;
}

/* The one-click POST, RFC 8058. ⚠ Mail providers send this WITHOUT the person
   ever seeing a page — Gmail and Apple Mail show their own "unsubscribe" button
   and post here when it is pressed. The body is `List-Unsubscribe=One-Click`
   and is deliberately not read: the token in the URL is the whole request.

   ⚠ It must answer 2xx quickly and say nothing else. A redirect or an HTML body
   here is a failed unsubscribe as far as the provider is concerned. */
router.post(
  "/unsubscribe",
  wrap(async (req, res) => {
    await unsubscribe(req.query.t);
    /* ⚠ 200 even for a bad token. The provider cannot fix it, will not show the
       error to anyone, and a 4xx teaches it that this sender's unsubscribe
       button does not work. */
    res.status(200).end();
  })
);

/* The link in the email, clicked by a person. */
router.get(
  "/unsubscribe",
  wrap(async (req, res) => {
    const done = await unsubscribe(req.query.t);

    if (!done) {
      /* ⚠ 400 and a page that does not pretend it worked. The likely cause is a
         mangled link — a mail client that wrapped it over two lines — so it
         says what to do next rather than just refusing. */
      return send(
        res,
        400,
        page({
          title: "That link did not work",
          heading: "That link did not work",
          message:
            "It may have been cut in half by your email app. Reply to any email from us and we will take you off the list by hand.",
        })
      );
    }

    return send(
      res,
      200,
      page({
        title: "You have been unsubscribed",
        heading: "You have been unsubscribed",
        /* ⚠ Says plainly what has NOT stopped. Someone unsubscribing from the
           newsletter has not cancelled their place at an event, and a page that
           left that ambiguous would have people turning up expecting nothing or
           not turning up at all. */
        message:
          "You will not receive any more newsletters from Iwan Community. Confirmations for events you have registered for will still be sent — unsubscribing does not cancel a booking.",
      })
    );
  })
);

export default router;
