/* Sends a signed webhook to your own API, exactly as Resend would.

     npm run webhook:ping                            # an unsubscribe
     npm run webhook:ping -- --email=you@example.com
     npm run webhook:ping -- --resubscribe
     npm run webhook:ping -- --type=email.complained
     npm run webhook:ping -- --forged                # prove it is refused
     npm run webhook:ping -- --url=https://…         # a tunnel, or a deployment

   ⚠ NO TUNNEL AND NO RESEND ACCOUNT. The signature is HMAC arithmetic over the
   bytes, so anything holding the same RESEND_WEBHOOK_SECRET can produce one —
   which is the whole reason that secret is a secret. This is the inner loop;
   pointing a real Resend webhook at a tunnel is how you prove the DASHBOARD
   half, and the README says how.

   ⚠ It signs the exact string it posts, never an object re-encoded on the way
   out — the same property routes/webhooks.js depends on at the other end. */

import "dotenv/config";
import { createHmac, randomBytes } from "node:crypto";

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v = true] = a.replace(/^--/, "").split("=");
    return [k, v];
  })
);

const secret = args.get("secret") || process.env.RESEND_WEBHOOK_SECRET || "";

/* ⚠ The one thing that cannot be defaulted: a generated secret would sign
   perfectly and verify against nothing, and the 400 would look like a bug in
   the route rather than a missing variable.

   ⚠ It prints the COMMAND, not a value. A secret this script invented would be
   a real credential the moment it was pasted in, and it would already be in
   scrollback by then. */
if (!secret) {
  console.error(`
RESEND_WEBHOOK_SECRET is not set, so there is nothing to sign with.

Generate one straight into .env and restart the API — for local work it does not
have to be the one Resend issued, it only has to MATCH on both sides:

  echo "RESEND_WEBHOOK_SECRET=whsec_$(head -c 24 /dev/urandom | base64)" >> .env
`);
  process.exit(1);
}

const url =
  args.get("url") || `http://localhost:${process.env.PORT ?? 4000}/api/webhooks/resend`;

const email = args.get("email") || "someone@example.com";
const type = args.get("type") || "contact.updated";

/* The shapes Resend actually sends, cut down to the fields the route reads. */
const bodies = {
  "contact.updated": {
    id: `ct_${randomBytes(6).toString("hex")}`,
    email,
    /* An unsubscribe is the default because it is the event worth proving:
       it is the one that changes something and the one the whole route
       exists for. */
    unsubscribed: !args.has("resubscribe"),
  },
  "contact.created": {
    id: `ct_${randomBytes(6).toString("hex")}`,
    email,
    unsubscribed: false,
  },
  "contact.deleted": { id: `ct_${randomBytes(6).toString("hex")}`, email },
  "email.complained": { email_id: `em_${randomBytes(6).toString("hex")}`, to: [email] },
  "email.bounced": {
    email_id: `em_${randomBytes(6).toString("hex")}`,
    to: [email],
    bounce: {
      type: "Permanent",
      subType: "General",
      message: "The address does not exist",
    },
  },
  "email.opened": { email_id: `em_${randomBytes(6).toString("hex")}`, to: [email] },
};

if (!bodies[type]) {
  console.error(`Unknown --type. Try one of:\n  ${Object.keys(bodies).join("\n  ")}`);
  process.exit(1);
}

const payload = JSON.stringify({
  type,
  created_at: new Date().toISOString(),
  data: bodies[type],
});

const id = `msg_${randomBytes(8).toString("hex")}`;
const timestamp = String(Math.floor(Date.now() / 1000));

/* ⚠ `whsec_` then BASE64 is the format Resend issues, and the key is the
   DECODED bytes — signing with the printable string verifies against nothing. */
const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
const signature = createHmac("sha256", key)
  .update(`${id}.${timestamp}.${payload}`)
  .digest("base64");

const res = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "svix-id": id,
    "svix-timestamp": timestamp,
    /* `--forged` posts a signature that is not one, so you can watch the route
       refuse it — the failure is as worth seeing as the success. */
    "svix-signature": args.has("forged") ? "v1,not-a-real-signature" : `v1,${signature}`,
  },
  body: payload,
}).catch((err) => {
  console.error(`\nCould not reach ${url}\n  ${err.message}\n`);
  console.error("Is the API running?  npm run dev   (or npm run dev:memory)\n");
  process.exit(1);
});

const text = await res.text();

console.log(`
  → POST ${url}
    ${type}  ${email}${args.has("forged") ? "   (deliberately unsigned)" : ""}

  ← ${res.status}  ${text}
`);

/* ⚠ A 400 is the CORRECT answer to --forged, so it is not a failure here. */
const expected = args.has("forged") ? 400 : 200;
if (res.status !== expected) {
  console.error(
    `  Expected ${expected}. ${
      res.status === 503
        ? "A 503 means the API has no RESEND_WEBHOOK_SECRET — it needs the same one, and a restart."
        : res.status === 400
          ? "A 400 means the signature did not verify — the two secrets differ, or something parsed the body first."
          : ""
    }\n`
  );
  process.exit(1);
}
