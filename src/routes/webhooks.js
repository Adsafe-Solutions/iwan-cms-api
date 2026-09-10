import express, { Router } from "express";
import { CONFIG } from "../config.js";
import { verifier } from "../lib/resendClient.js";
import { Audience } from "../models/Audience.js";

/* Resend calling US — the only inbound half of the contact sync.

   lib/contacts.js pushes subscribers out to Resend. Everything that happens on
   Resend's side after that arrives here: somebody clicking unsubscribe at the
   bottom of a broadcast, an editor removing a contact in Resend's dashboard, a
   mailbox reporting a message as spam. Without this the two lists drift apart
   within one campaign, and the drift is the dangerous direction — Iwan would go
   on believing someone is subscribed after they have said otherwise.

   ⚠ MOUNTED BEFORE express.json() IN app.js, and it has to be. The signature is
   computed over the EXACT bytes Resend sent; parsing the JSON and re-encoding it
   changes key order and whitespace, and every verification fails. This router
   parses its own raw body and nothing else here does.

   ⚠ NOTHING HERE CREATES A PERSON. recordAudience is the one way into the
   audience list, and a webhook that could insert rows would be an unauthenticated
   write to the audience the moment the signing secret leaked. An event for an
   address Iwan has never seen updates nothing and is answered 200 all the same:
   Resend is not at fault, and retrying it forever would help nobody. */

const router = Router();

/* Ten minutes' worth of retries arrive as new requests, so this stays small.
   Resend's own payloads are a few kilobytes; anything near this is not one. */
const rawJson = express.raw({ type: "*/*", limit: "256kb" });

/* Resend sends the Svix header trio. The SDK does the actual comparison —
   timestamp tolerance, the v1 scheme, a timing-safe compare — so the scheme
   is not reimplemented here and cannot drift from theirs. */
const svixHeaders = (req) => ({
  id: req.get("svix-id") ?? "",
  timestamp: req.get("svix-timestamp") ?? "",
  signature: req.get("svix-signature") ?? "",
});

/* ⚠ Update-only, by email. `updateOne` with no upsert is doing the work of the
   comment above: an unknown address matches nothing and writes nothing. */
const update = (email, set) =>
  Audience.updateOne(
    {
      email: String(email ?? "")
        .trim()
        .toLowerCase(),
    },
    { $set: set }
  );

/* What each event does to the row. Everything not listed is acknowledged and
   ignored — Resend's event list grows, and an unknown type is not an error. */
async function apply(event) {
  const { type, data } = event;

  switch (type) {
    /* The one that matters. `unsubscribed` is Resend's flag and the NEGATIVE of
       Iwan's, so it is inverted on the way in exactly as it is on the way out.
       ⚠ This is the only place other than an editor's own edit in the CMS where
       `subscribed` goes back to false — the model's rule that a form can never
       unsubscribe anyone still holds, because this is not a form. */
    case "contact.created":
    case "contact.updated":
      if (!data?.email) return "no-email";
      /* ⚠ Unsubscribing clears the welcome stamp, so coming back later is a
         new subscription with its own welcome — see the model. Re-subscribing
         does NOT set it: the welcome is sent by the form that opts somebody in,
         not by Resend telling us it happened. */
      await update(data.email, {
        subscribed: !data.unsubscribed,
        ...(data.unsubscribed ? { welcomeSentAt: null, welcomedCountries: [] } : {}),
      });
      return data.unsubscribed ? "unsubscribed" : "subscribed";

    /* Gone from Resend's list, so nothing can be mailed to them through it.
       ⚠ The PERSON is kept: their messages, their registrations and their
       application history are Iwan's records, not Resend's, and deleting a
       contact in a mailing tool is not a request to be forgotten. */
    case "contact.deleted":
      if (!data?.email) return "no-email";
      await update(data.email, {
        subscribed: false,
        welcomeSentAt: null,
        welcomedCountries: [],
      });
      return "unsubscribed";

    /* A spam report. Legally and reputationally this is stronger than an
       unsubscribe: carrying on mailing someone who has complained is how a
       sending domain gets blocked, so it comes off the list here rather than
       waiting for the contact event that may not follow. */
    case "email.complained":
      await Promise.all(
        (data?.to ?? []).map((to) =>
          update(to, { subscribed: false, welcomeSentAt: null, welcomedCountries: [] })
        )
      );
      return "complained";

    /* ⚠ LOGGED, NOT ACTED ON, and deliberately. A bounce is not consent
       withdrawn — a full mailbox, a server having a bad afternoon and a
       permanently dead address all arrive as one event, and unsubscribing on
       the first would quietly drop people who are still reading. Recording a
       delivery state per person is the right fix and wants a field of its own;
       until then the log is honest about what is known. */
    case "email.bounced":
      /* ⚠ NO ADDRESS IN THE LOG. Who bounced is personal data and this line
         goes to the platform's log store, which outlives the request, is read
         by more people than the database is, and is not where anyone should
         have to go looking for it. The count and the kind are what a bounce
         rate is read from; the address is already on the message in Resend. */
      return "logged";

    default:
      return "ignored";
  }
}

router.post("/resend", rawJson, async (req, res) => {
  /* ⚠ 503, not 500: with no secret configured this endpoint cannot verify
     anything, and the honest answer is that it is not ready — not that Resend
     sent something wrong. Resend retries a 503, so events are not lost while
     the variable is being set.

     ⚠ The SIGNING SECRET is the only thing checked for. Verifying Resend's
     calls back is a separate job from sending, and this route works on a
     deployment holding no API key at all — see resendClient.js. */
  if (!CONFIG.resendWebhookSecret) {
    return res.status(503).json({ error: "Webhooks are not configured" });
  }

  let event;
  try {
    /* ⚠ VERIFY BEFORE READING. Everything below this line comes from a request
       anyone on the internet can make; the signature is the only thing that
       makes it Resend's. `req.body` is a Buffer here, and the bytes go in
       exactly as they arrived. */
    event = verifier.webhooks.verify({
      payload: Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body),
      headers: svixHeaders(req),
      webhookSecret: CONFIG.resendWebhookSecret,
    });
  } catch (err) {
    /* ⚠ 400 and not 401, on purpose: a 4xx tells Resend to stop retrying, and
       a request that cannot be verified will not verify on the fifth attempt
       either. The reason goes to the log, never to the caller. */
    return res.status(400).json({ error: "Invalid signature" });
  }

  try {
    const result = await apply(event);
    /* ⚠ 200 for anything understood, including "ignored". A non-2xx is a
       retry request, and asking to be sent an event again that was handled
       correctly the first time is how a webhook endpoint ends up hammered. */
    return res.json({ ok: true, type: event.type, result });
  } catch (err) {
    /* A database failure IS worth retrying — the event was real and the write
       did not happen. 500 asks Resend to send it again. */
    return res.status(500).json({ error: "Could not apply the event" });
  }
});

export default router;
