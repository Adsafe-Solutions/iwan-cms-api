import { Audience } from "../models/Audience.js";
import { mirrorContact } from "./contacts.js";

/* The one way a person reaches the audience list. Every public form calls this
   and nothing writes Audience directly, so the merge rules live in one place.

   ⚠ FILL BLANKS, NEVER OVERWRITE. A later form can supply a name or a mobile
   this row does not have; it cannot replace one it does. A hurried "aisha" in
   a newsletter box must not be able to degrade "Aisha Rahman" captured on a
   registration form, and there is no way to tell the two apart at write time.
   Correcting a value is a deliberate edit in the CMS.

   ⚠ `subscribed` only ever goes UP here. An unticked box on a contact form is
   not an unsubscribe — see the note on the model. */
export async function recordAudience({
  email,
  name = "",
  mobile = "",
  subscribe = false,
  source,
  country,
  message = null,
}) {
  const address = String(email ?? "")
    .trim()
    .toLowerCase();
  if (!address) return null;

  const now = new Date();

  /* Everything that is safe to apply unconditionally. */
  const set = { lastSeenAt: now };
  const setOnInsert = { email: address, country };
  const addToSet = { sources: source };

  if (subscribe) set.subscribed = true;

  const push = {};
  if (message?.body || message?.subject) {
    push.messages = { ...message, country, at: now };
  }

  /* ⚠ Two steps rather than one. Mongo cannot express "set this field only if
     it is currently empty" in a single update, and doing it in one would mean
     choosing between always overwriting and never filling. The upsert creates
     or touches the row; the second update fills the blanks it actually has. */
  await Audience.updateOne(
    { email: address },
    {
      $set: set,
      $setOnInsert: setOnInsert,
      $addToSet: addToSet,
      ...(Object.keys(push).length ? { $push: push } : {}),
    },
    { upsert: true }
  );

  const blanks = {};
  if (name) blanks.name = name;
  if (mobile) blanks.mobile = mobile;

  if (Object.keys(blanks).length) {
    await Audience.updateOne(
      {
        email: address,
        /* Only the fields that are missing or empty on the stored row. */
        $or: Object.keys(blanks).flatMap((key) => [
          { [key]: "" },
          { [key]: { $exists: false } },
        ]),
      },
      [
        {
          $set: Object.fromEntries(
            Object.entries(blanks).map(([key, value]) => [
              key,
              {
                $cond: [{ $in: [{ $ifNull: [`$${key}`, ""] }, [""]] }, value, `$${key}`],
              },
            ])
          ),
        },
      ]
    );
  }

  const person = await Audience.findOne({ email: address }).lean();

  /* ⚠ MIRRORED TO RESEND FROM HERE, because this is the one way a person
     reaches the audience list — putting it in the subscribe route instead
     would mirror the newsletter box and quietly miss the four other forms that
     can also tick it.

     ⚠ EVERYONE IS MIRRORED, SUBSCRIBED OR NOT, and `unsubscribed` on the Resend
     contact says which. Somebody who registered for an event without ticking
     the newsletter box belongs in the event segment — that is the list of who
     came, not the list of who wants mail — and leaving them out made those
     segments silently incomplete.

     ⚠ WHAT PROTECTS THEM IS THE FLAG, not their absence. A contact marked
     `unsubscribed` is skipped by every broadcast, so this is a suppression
     record rather than a mailing list entry. The row's own `subscribed` is
     read, never the `subscribe` argument, so an untouched box on a later form
     cannot quietly opt anybody in.

     ⚠ AWAITED, and recordAudience itself is called before every response —
     see lib/contacts.js and lib/background.js. Off Vercel this returns at once
     and the push finishes on its own; on Vercel nothing survives the response,
     which is precisely how a subscriber ended up stored here and absent from
     Resend. It still cannot fail the form: syncContact never throws. */
  if (person) {
    await mirrorContact({
      email: address,
      name: person.name,
      subscribed: Boolean(person.subscribed),
      /* ⚠ Where they FIRST came from, not the form in front of us. `sources` is
         kept in first-seen order, and the property is paired with `joined`,
         which is the row's creation date — a returning subscriber whose source
         flipped to whichever form they last touched would make a segment built
         on it mean nothing. */
      source: person.sources?.[0] ?? source,
      /* ⚠ All of them, for the per-source segments — see lib/segments.js. */
      sources: person.sources ?? [source].filter(Boolean),
      country: person.country ?? country,
      /* ⚠ Where they FIRST arrived and where they are acting NOW — see
         lib/segments.js. The row keeps only the first, so without this a
         returning person is never filed under the other country. */
      countries: [person.country, country],
      subscribedAt: person.createdAt,
    });
  }

  return person;
}

export default recordAudience;

/* Whether this address is on the newsletter, for deciding what an email SAYS
   rather than who it goes to.

   ⚠ NEVER THROWS and answers `false` when it cannot tell. The caller is a mail
   send that must not fail over this, and "not known to be subscribed" is the
   honest reading of a failed lookup — the List-Unsubscribe header is on the
   message either way, so nobody is left without a way off the list. */
export async function isSubscribed(email) {
  const address = String(email ?? "")
    .trim()
    .toLowerCase();
  if (!address) return false;

  try {
    const row = await Audience.findOne({ email: address }).select("subscribed").lean();
    return Boolean(row?.subscribed);
  } catch (err) {
    return false;
  }
}
