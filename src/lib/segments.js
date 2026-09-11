import { CONFIG } from "../config.js";
import { resend } from "./resendClient.js";

/* The Resend segments a mirrored contact belongs to.

   ⚠ A RESEND SEGMENT IS A STATIC LIST. Creating one takes a name and nothing
   else — there are no filter rules, so "everyone whose source is event" cannot
   maintain itself. Membership has to be written, which is what this does.

   ⚠ CREATED ON FIRST USE, not configured. An account with none of them gets
   them on the first sync; an account that already has them by name keeps
   exactly those. Nothing to paste into an environment variable, and nothing to
   keep in step by hand.

   ⚠ NAMES ARE THE CONTRACT, because a segment id is a UUID nobody can choose.
   Renaming one in the dashboard makes this create a new one beside it — which
   is why they read as labels somebody would not casually retitle. */

/* ⚠ THREE, BECAUSE THE PLAN ALLOWS THREE. Resend caps segments by plan, so
   these are the ones worth spending them on: the two countries, which decide
   which newsletter somebody should get at all, and event registrations, which
   is the audience most likely to be written to on its own.

   ⚠ "Event registrations" IS EVERYONE WHO REGISTERED, subscribed or not — it is
   the list of who came, not of who wants mail. The ones who never opted in are
   in it as `unsubscribed` contacts, which every broadcast skips, so the segment
   is complete without becoming a way to mail people who never asked.

   ⚠ SUBSCRIBERS NEED NO SEGMENT OF THEIR OWN. Resend already knows who is
   subscribed — `unsubscribed` is a field on every contact — so a "Newsletter"
   segment would only restate it, and a broadcast can be sent to a country
   segment without one.

   ⚠ Volunteers, career applicants and contact-form senders are NOT segmented
   for the same reason a cap exists: they are still findable by their `source`
   property, which every contact carries. Adding one here costs a segment, so
   it needs a plan that has one to spare — and nothing else changes. */
export const SEGMENT_NAMES = {
  in: "Iwan India",
  ca: "Iwan Canada",
  event: "Event registrations",
};

/* ⚠ Cached for the life of the process, and the cache holds the WHOLE account's
   segments after one call — resolving five names must not be five round trips
   on every sign-up. A segment created in the dashboard after boot is picked up
   on the next restart; on Vercel an instance lives minutes. */
let all = null;

/* ⚠ RESEND ALLOWS TWO SEGMENTS WITH THE SAME NAME. It does not refuse a
   duplicate create, so a name has to be resolved to ONE id deterministically or
   different instances file people into different lists with identical labels —
   which is exactly what happened: two "Iwan India" segments, one with a single
   contact and one with four.

   ⚠ OLDEST WINS. Every instance sees the same list and makes the same choice,
   whatever order it arrives in, so they converge on one segment rather than
   racing. It also means a duplicate created by accident is ignored rather than
   half-used, and deleting it in the dashboard loses nothing. */
const pick = (segments) => {
  const byName = new Map();
  for (const segment of segments) {
    const held = byName.get(segment.name);
    if (!held || String(segment.created_at) < String(held.created_at)) {
      byName.set(segment.name, segment);
    }
  }
  return new Map([...byName].map(([name, segment]) => [name, segment.id]));
};

async function load() {
  if (all) return all;

  const { data, error } = await resend.segments.list();
  if (error) throw new Error(error.message ?? "could not list segments");

  all = pick(data?.data ?? []);
  return all;
}

/* ⚠ ONE CREATE PER NAME PER PROCESS, held as a promise. Four forms submitted at
   once would otherwise each find the name missing and each create it — the
   `load()` cache does not help, because none of them has finished yet. */
const creating = new Map();

async function ensure(name) {
  const known = await load();
  if (known.has(name)) return known.get(name);

  if (!creating.has(name)) {
    creating.set(
      name,
      (async () => {
        /* ⚠ Re-read first. Another INSTANCE may have created it since this one
           listed, and Resend would happily accept a second with the same name. */
        all = null;
        const fresh = await load();
        if (fresh.has(name)) return fresh.get(name);

        const { data, error } = await resend.segments.create({ name });
        if (error || !data?.id) {
          all = null;
          return (await load()).get(name) ?? null;
        }

        fresh.set(name, data.id);
        return data.id;
      })().finally(() => creating.delete(name))
    );
  }

  return creating.get(name);
}

/**
 * The segment ids one person belongs in: their country, and event registrations
 * if they have ever registered for one.
 *
 * ⚠ NEVER THROWS. A contact in no segment is still a contact, and losing the
 * whole sync because a grouping could not be read would be the wrong trade.
 *
 * @returns {Promise<string[]>}
 */
export async function segmentsFor({ countries = [], sources = [] } = {}) {
  if (!resend) return [];

  /* ⚠ An explicitly configured segment is still included where one is set —
     that is a list an account may already be broadcasting to, and dropping it
     would quietly empty something somebody relies on. ⚠ It counts against the
     plan's cap like any other, so leave RESEND_SEGMENT_ID unset unless it is a
     segment you actually use. */
  const wanted = new Set(CONFIG.resendSegmentId ? [CONFIG.resendSegmentId] : []);

  /* ⚠ EVERY country this person has acted through, not just the one they first
     arrived from. Somebody who registered in India and later subscribed on the
     Canadian site belongs on both lists — filing them under the row's original
     country only was why the Canadian segment never appeared at all for anyone
     already known. */
  const names = [
    ...countries.map((code) => SEGMENT_NAMES[code]),
    ...sources.map((source) => SEGMENT_NAMES[source]),
  ].filter(Boolean);

  try {
    for (const name of names) {
      const id = await ensure(name);
      if (id) wanted.add(id);
    }
  } catch {
    /* Whatever was resolved before the failure is still worth using. */
  }

  return [...wanted];
}

/**
 * Puts an existing contact into the segments it belongs to.
 *
 * ⚠ ONLY FOR A CONTACT THAT ALREADY EXISTS. A new one carries its segments on
 * the create call, which is one request rather than one per segment — this is
 * the slower path, used when there was nothing to create.
 *
 * ⚠ NEVER THROWS, and duplicates are ignored: adding somebody to a segment
 * they are already in is the state we wanted.
 */
export async function addToSegments(email, segmentIds = []) {
  if (!resend || !email || !segmentIds.length) return;

  for (const segmentId of segmentIds) {
    try {
      await resend.contacts.segments.add({ email, segmentId });
    } catch {
      /* Already there, or gone — neither is worth failing a sign-up over. */
    }
  }
}

/* Only for the smoke suite, which needs more than one answer in one process. */
export const forgetSegments = () => {
  all = null;
};

export default segmentsFor;
