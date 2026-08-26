import { Audience } from "../models/Audience.js";

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

  return Audience.findOne({ email: address }).lean();
}

export default recordAudience;
