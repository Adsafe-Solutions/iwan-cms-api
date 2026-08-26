/* CLI wrapper around scripts/seed-lib.js.

     npm run seed                        # from ../iwan (the sibling checkout)
     npm run seed -- --from=/path/to/iwan/src/content/base
     npm run seed:reset                  # empty the content collections first

   Idempotent — everything is upserted on its slug — and never touches user
   accounts. */

import path from "node:path";
import mongoose from "mongoose";
import { CONFIG, assertConfig } from "../src/config.js";
import { connectDb, disconnectDb } from "../src/db.js";
import { seedInto, DEFAULT_SOURCE, SEEDABLE } from "./seed-lib.js";

const argv = process.argv.slice(2);
const flag = (name) =>
  argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split("=")
    .slice(1)
    .join("=");

const source = path.resolve(flag("from") ?? DEFAULT_SOURCE);
const reset = argv.includes("--reset");

/* ⚠ The default is everything, which OVERWRITES every content type from the
   static files. Once real content is being edited, name the type you mean
   (`--only=blogs`) or refreshing one resets the other three. */
const only = (flag("only") ?? SEEDABLE.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const unknown = only.filter((t) => !SEEDABLE.includes(t));
if (unknown.length) {
  console.error(
    `[seed] unknown --only value: ${unknown.join(", ")}\n` +
      `       choose from: ${SEEDABLE.join(", ")}`
  );
  process.exit(1);
}

async function main() {
  assertConfig();

  console.log(`[seed] source: ${source}`);
  /* Stripped before printing — this ends up in CI logs and scrollback. */
  console.log(`[seed] target: ${CONFIG.mongoUri.replace(/\/\/[^@]+@/, "//***@")}`);
  console.log(`[seed] types:  ${only.join(", ")}`);

  await connectDb();

  if (reset) console.log(`[seed] --reset: emptying ${only.join(", ")}`);

  const counts = await seedInto({ source, reset, only });

  /* Only what was asked for: "0 events" after `--only=blogs` reads as a
     failure. */
  const line = [
    only.includes("events") && `${counts.events} events`,
    only.includes("blogs") && `${counts.blogs} posts`,
    only.includes("podcast") && `${counts.episodes} episodes`,
    only.includes("promos") && `${counts.promos} promos`,
  ].filter(Boolean);

  console.log(`[seed] ${line.join(" · ")}`);
  console.log("[seed] done");

  await disconnectDb();
}

main().catch(async (err) => {
  console.error(`[seed] failed: ${err.message}`);
  if (mongoose.connection.readyState === 1) await disconnectDb();
  process.exit(1);
});
