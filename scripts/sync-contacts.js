/* Pushes the audience that is ALREADY in the database up to Resend.

     npm run sync:contacts -- --dry     # say what it would do, touch nothing
     npm run sync:contacts

   The live sync in lib/contacts.js only fires when somebody submits a form, so
   without this the people who subscribed BEFORE it existed reach Resend one at
   a time as they happen to come back — which for most of a list is never. This
   is the one-off that carries them over, and it is the only manual step
   between deploying and having a usable list.

   ⚠ SAFE TO RE-RUN, and safe to interrupt. Every contact is an upsert keyed on
   the address — create, or update the one already there — so a second run
   changes nothing and a run that stopped half way is finished by the next one.
   Nothing here deletes.

   ⚠ It reads the LIVE database, like everything else in this repo. It writes
   only to Resend; no Mongo document is modified. */

import "dotenv/config";

const DRY = process.argv.includes("--dry");
/* By default only people who agreed to be mailed. `--all` also pushes the rest
   AS UNSUBSCRIBED, which is a suppression record rather than a mailing list —
   worth having if the same addresses might be imported into Resend by another
   route later, and noise otherwise. */
const ALL = process.argv.includes("--all");

const { CONFIG } = await import("../src/config.js");

/* ⚠ Checked before the database is touched: without a key this cannot do
   anything at all, and connecting first would make that look like a failure
   half way through. */
if (!CONFIG.resendApiKey) {
  console.error(
    "\nRESEND_API_KEY is not set, so there is nowhere to sync to.\nSet it in the environment and run this again.\n"
  );
  process.exit(1);
}

const { connectDb, disconnectDb } = await import("../src/db.js");
const { Audience } = await import("../src/models/Audience.js");
const { syncContact } = await import("../src/lib/contacts.js");

await connectDb();

const where = ALL ? {} : { subscribed: true };
const total = await Audience.countDocuments(where);

console.log(`
  ${total} ${ALL ? "people" : "subscribers"} to sync${DRY ? "   (dry run — nothing will be sent)" : ""}
  ${CONFIG.resendSegmentId ? `into segment ${CONFIG.resendSegmentId}` : "with no segment set — they will be ungrouped contacts"}
`);

/* ⚠ Resend allows 10 requests per second PER TEAM, and this is not the only
   thing spending them: a sign-up mid-run sends a confirmation and syncs its own
   contact from the same budget. Five a second leaves half the allowance for the
   live site, and a backfill is not in a hurry. */
const PACE_MS = 200;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tally = { synced: 0, untagged: 0, failed: 0, skipped: 0 };
const failures = [];

/* ⚠ A CURSOR, not find().lean() — a list of any size streams one document at a
   time instead of being held in memory at once, and this runs against whatever
   the audience has grown to rather than whatever it was when it was written. */
const cursor = Audience.find(where).sort({ createdAt: 1 }).lean().cursor();

let seen = 0;

for await (const person of cursor) {
  seen += 1;

  if (!person.email) {
    tally.skipped += 1;
    continue;
  }

  if (DRY) {
    tally.synced += 1;
    /* Enough to check the mapping before committing to it — the first few in
       full, then just the count. */
    if (seen <= 5) {
      console.log(
        `    ${person.email}   source=${person.sources?.[0] ?? ""}  country=${(person.country ?? "").toUpperCase()}  joined=${new Date(person.createdAt).toISOString().slice(0, 10)}  ${person.subscribed ? "" : "(unsubscribed)"}`
      );
    }
    continue;
  }

  const result = await syncContact({
    email: person.email,
    name: person.name,
    subscribed: Boolean(person.subscribed),
    /* ⚠ Where they FIRST came from, matching the live sync — see
       lib/audience.js. A backfill that recorded something else would put the
       list out of step with everyone who joins after it. */
    source: person.sources?.[0] ?? "",
    country: person.country ?? "",
    subscribedAt: person.createdAt,
  });

  if (!result.synced) {
    tally.failed += 1;
    failures.push(`${person.email}: ${result.reason}`);
  } else {
    tally.synced += 1;
    if (result.tagged === false) tally.untagged += 1;
  }

  /* A line every fifty, so a long run shows progress without scrolling. */
  if (seen % 50 === 0) console.log(`    ${seen}/${total}…`);

  await pause(PACE_MS);
}

await disconnectDb();

console.log(`
  ${DRY ? "Would sync" : "Synced"}: ${tally.synced}${tally.untagged ? `   (${tally.untagged} without properties — see the log above)` : ""}
  ${tally.skipped ? `Skipped (no address): ${tally.skipped}` : ""}
  ${tally.failed ? `Failed: ${tally.failed}` : ""}
`);

if (failures.length) {
  /* ⚠ Named, not just counted. A failure list you cannot act on is a number. */
  console.log("  These did not sync:");
  for (const line of failures.slice(0, 20)) console.log(`    ${line}`);
  if (failures.length > 20) console.log(`    …and ${failures.length - 20} more`);
  console.log("\n  Re-running is safe and will retry them.\n");
}

/* ⚠ Non-zero on failures so a run wired into anything notices. */
process.exit(failures.length ? 1 : 0);
