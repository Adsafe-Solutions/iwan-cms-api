import { CONFIG } from "../config.js";
import { resend } from "./resendClient.js";
import { background } from "./background.js";

/* The audience list, mirrored into Resend.

   Iwan's own `Audience` collection stays the record of truth — it holds the
   messages, the sources, the notes and the people who never subscribed at all.
   What goes to Resend is the subset that can be MAILED, so a broadcast can be
   written in Resend's own composer instead of exporting a CSV every time.

   ⚠ ONE DIRECTION EACH WAY. This file only ever pushes; nothing here reads
   Resend back. Changes made on Resend's side — someone clicking unsubscribe at
   the bottom of a broadcast — come back through the webhook in
   routes/webhooks.js, which is the only inbound path.

   ⚠ NEVER THROWS, and callers do not await it. A subscription is stored the
   moment recordAudience returns; whether Resend accepted the mirror is a
   separate question, and a third party being down must never turn a filled-in
   form into an error the person retries. */

/* A contact is only worth mirroring when there is somewhere to put it. */
export const CONTACTS_ENABLED = Boolean(resend);

/* ⚠ Resend contacts have no "tags" field — `properties` is the equivalent, a
   flat map of custom key/values. These four are what Iwan actually sorts people
   by. Keys are fixed here rather than passed in, so every contact carries the
   same shape and a broadcast personalised on one of them never meets a contact
   that lacks it.

   ⚠ A PROPERTY MUST EXIST ON THE ACCOUNT BEFORE A CONTACT CAN CARRY IT. Resend
   does not create one on first use — it REFUSES THE WHOLE CONTACT, so an
   account without these four would reject every sync rather than storing the
   contact and dropping the extras. ensureProperties below is what stops that
   being a manual setup step nobody remembers.

   ⚠ Keys are alphanumeric and underscore only, max 50 — Resend's rule, which is
   why `managed_by` is not `managed-by`. */
const PROPERTY_DEFINITIONS = [
  /* A fallback is what a contact created OUTSIDE this API gets — somebody added
     by hand in the dashboard — so a broadcast personalised on one of these
     never renders a blank. */
  { key: "source", type: "string", fallbackValue: "" },
  { key: "country", type: "string", fallbackValue: "" },
  { key: "joined", type: "string", fallbackValue: "" },
  { key: "managed_by", type: "string", fallbackValue: "dashboard" },
];

/* ⚠ Once per process, not once per contact — memoised on the PROMISE so a
   burst of sign-ups on a cold instance shares one round trip rather than
   racing four creates each. A failure is not remembered: `ensured` is cleared
   so the next sync tries again, which is how a property deleted in the
   dashboard heals itself without a redeploy.

   The repo does this for the default application forms too (see
   lib/applyForms.js), but at BOOT. Here it is lazy on purpose: a deployment
   that never takes a subscriber should not spend a round trip on every cold
   start proving something it will not use. */
let ensured = null;

async function ensureProperties() {
  if (!ensured) {
    ensured = (async () => {
      const { data, error } = await resend.contactProperties.list();
      if (error) throw new Error(error.message ?? "could not list properties");

      const existing = new Set((data?.data ?? []).map((p) => p.key));
      const missing = PROPERTY_DEFINITIONS.filter((p) => !existing.has(p.key));

      for (const property of missing) {
        const created = await resend.contactProperties.create(property);
        /* ⚠ A race between two instances creating the same key lands here and
           is a SUCCESS — the property exists, which is all this needed. */
        if (created.error && !alreadyExists(created.error)) {
          throw new Error(created.error.message ?? `could not create ${property.key}`);
        }
      }
    })().catch((err) => {
      ensured = null;
      throw err;
    });
  }
  return ensured;
}

const properties = ({ source, country, subscribedAt }) => ({
  /* Which form brought them in: subscribe · contact · event · volunteer · career. */
  source: source ?? "",
  /* The site they came through, upper-cased to read as a country in the UI. */
  country: (country ?? "").toUpperCase(),
  /* A day string, not a timestamp — the same reasoning content dates get. */
  joined: (subscribedAt ?? new Date()).toISOString().slice(0, 10),
  /* ⚠ Says where the row came from, so a contact added by hand in Resend's
     dashboard is distinguishable from one this API mirrored. */
  managed_by: "iwan-cms",
});

/* Resend wants the name in two halves and Iwan stores it in one. Split at the
   FIRST space: "Aisha" is a first name, "Aisha Rahman" is both, and "Maria del
   Carmen Santos" keeps everything after the first space together rather than
   inventing a middle name. A blank name sends neither half. */
const splitName = (name = "") => {
  const trimmed = String(name).trim();
  if (!trimmed) return {};
  const at = trimmed.indexOf(" ");
  if (at === -1) return { firstName: trimmed };
  return {
    firstName: trimmed.slice(0, at),
    lastName: trimmed.slice(at + 1).trim(),
  };
};

/* Resend answers a repeat create with an error rather than an upsert, and the
   wording is not a contract. Anything that mentions the contact already being
   there is treated as "update it instead", and anything else is a real failure
   worth logging. */
const alreadyExists = (error) =>
  /exist|duplicate|already/i.test(`${error?.name ?? ""} ${error?.message ?? ""}`);

/**
 * Puts one person into Resend, or brings the copy already there up to date.
 *
 * ⚠ NEVER THROWS. Failures come back in the return value and are logged.
 *
 * @returns {Promise<{synced: boolean, id?: string, tagged?: boolean, reason?: string}>}
 */
export async function syncContact({
  email,
  name = "",
  subscribed = true,
  source = "",
  country = "",
  subscribedAt,
}) {
  if (!CONTACTS_ENABLED) return { synced: false, reason: "contacts-disabled" };

  const address = String(email ?? "")
    .trim()
    .toLowerCase();
  if (!address) return { synced: false, reason: "no-address" };

  /* ⚠ The properties have to exist on the account before a contact can carry
     them, and Resend refuses the whole contact when they do not — so this comes
     first. On failure the contact is still synced, WITHOUT its properties: a
     person on the list who cannot be segmented is worth having, and a person
     missing entirely is not. `tagged` in the return value says which happened. */
  let tagged = true;
  try {
    await ensureProperties();
  } catch {
    tagged = false;
  }

  /* ⚠ Resend's flag is the NEGATIVE of Iwan's: `unsubscribed`, not
     `subscribed`. Getting this backwards would mail everyone who opted out. */
  const payload = {
    email: address,
    unsubscribed: !subscribed,
    ...splitName(name),
    ...(tagged ? { properties: properties({ source, country, subscribedAt }) } : {}),
    /* Optional. With no segment configured the contact still lands in the
       account's contact list — a segment is a grouping, not a requirement. */
    ...(CONFIG.resendSegmentId ? { segments: [{ id: CONFIG.resendSegmentId }] } : {}),
  };

  try {
    /* ⚠ The SDK REPORTS errors in the result rather than throwing, exactly as
       it does for sends, so a bare try/catch would read a rejected create as a
       success. The catch is for the network-level failure it does throw on. */
    const created = await resend.contacts.create(payload);
    if (!created.error) return { synced: true, id: created.data?.id, tagged };

    if (!alreadyExists(created.error)) {
      return { synced: false, reason: created.error.message ?? "create-failed" };
    }

    /* Already there: update the copy by email. ⚠ `segments` is not accepted on
       update, which is why it is only on the create above — an existing
       contact keeps whatever segments it has been given. */
    const { segments, ...update } = payload;
    const updated = await resend.contacts.update(update);
    if (updated.error) {
      return { synced: false, reason: updated.error.message ?? "update-failed" };
    }
    return { synced: true, id: updated.data?.id, tagged };
  } catch (err) {
    return { synced: false, reason: err?.message ?? "sync-threw" };
  }
}

/**
 * Takes one person off Resend's list entirely — what an editor deleting a row
 * in the CMS means. ⚠ NEVER THROWS, same contract as everything else here.
 *
 * @returns {Promise<{removed: boolean, reason?: string}>}
 */
export async function removeContact(email) {
  if (!CONTACTS_ENABLED) return { removed: false, reason: "contacts-disabled" };

  const address = String(email ?? "")
    .trim()
    .toLowerCase();
  if (!address) return { removed: false, reason: "no-address" };

  try {
    const { error } = await resend.contacts.remove({ email: address });
    /* ⚠ Not there is the state we wanted. Deleting a person the mirror never
       received is a success, not a failure to report. */
    if (error && !/not.?found/i.test(error.message ?? "")) {
      return { removed: false, reason: error.message ?? "remove-failed" };
    }
    return { removed: true };
  } catch (err) {
    return { removed: false, reason: err?.message ?? "remove-threw" };
  }
}

/* ⚠ MUST BE AWAITED, and before the response — the same shape as `notify` in
   mail.js and for the same reason. See lib/background.js: a promise nobody
   waits on is abandoned the moment a Vercel function answers, which is exactly
   why a subscriber could be stored here and never appear in Resend. */
export const mirrorContact = (person) =>
  background("contact sync", () => syncContact(person));

export const forgetContact = (email) =>
  background("contact removal", () => removeContact(email));

export default syncContact;
