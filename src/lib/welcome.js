import { Audience } from "../models/Audience.js";
import { sendSubscribeWelcome } from "./mail.js";
import { background } from "./background.js";

/* "You're on the list" — sent once per person, ever.

   Every route that can put somebody on the newsletter calls this: the footer
   form, the checkbox on an event registration, and the same checkbox on the
   contact, volunteer and career forms. One place, so the rule about sending it
   exactly once cannot be true in some of them and not others.

   ⚠ It lives here rather than inside recordAudience because lib/mail.js already
   imports lib/audience.js (to decide whether a confirmation shows its
   unsubscribe footer). Sending from inside recordAudience would close that into
   a cycle — audience → mail → audience — which ES modules resolve by handing
   one of them a half-initialised copy of the other. */

/**
 * Sends the welcome if this person has not had it.
 *
 * ⚠ THE STAMP IS CLAIMED BEFORE THE SEND, not written after. Two submissions
 * arriving together would otherwise both read "not sent yet" and both send. The
 * update is conditional on the stamp still being empty, so exactly one of them
 * wins and the loser does nothing.
 *
 * ⚠ A FAILED SEND GIVES THE STAMP BACK, or one Resend outage would mean that
 * person is never greeted at all — the row would claim it had been done.
 *
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
export async function welcomeSubscriber(person) {
  if (!person?.email) return { sent: false, reason: "no-address" };

  /* ⚠ Not subscribed is not an error. Every form calls this; most people who
     fill one in have not ticked the box. */
  if (!person.subscribed) return { sent: false, reason: "not-subscribed" };

  const claimed = await Audience.updateOne(
    {
      _id: person._id,
      $or: [{ welcomeSentAt: null }, { welcomeSentAt: { $exists: false } }],
    },
    { $set: { welcomeSentAt: new Date() } }
  );

  /* Somebody already has it, now or at some point in the past. */
  if (!claimed.modifiedCount) return { sent: false, reason: "already-sent" };

  const result = await sendSubscribeWelcome({
    email: person.email,
    name: person.name,
    /* Where they first arrived from — the audience row's own country, so a
       Canadian subscriber gets Canada's template and Canada's links. */
    country: person.country ?? "",
  });

  if (!result.sent) {
    await Audience.updateOne({ _id: person._id }, { $set: { welcomeSentAt: null } });
  }

  return result;
}

/* What routes call. ⚠ MUST BE AWAITED, and before the response — see
   lib/background.js: on Vercel nothing survives the response being sent. */
export const welcome = (person) =>
  background("welcome email", () => welcomeSubscriber(person));

/* Whether this person has ALREADY been through all of that — what the footer
   form answers "you are already subscribed" to.
   ⚠ Read BEFORE `welcome` runs, or it is always true by the time it is asked. */
export const alreadySubscribed = (person) =>
  Boolean(person?.subscribed && person?.welcomeSentAt);

export default welcome;
