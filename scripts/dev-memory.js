/* Boots the API against a throwaway in-memory MongoDB, seeded and with a dev
   admin, so the stack runs with no Atlas cluster and no account setup.

     npm run dev:memory

   ⚠ Everything is gone when the process stops. Anything you want to keep needs
   a real MONGODB_URI and `npm run dev`. */

import "dotenv/config";
import { randomBytes } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";

/* ⚠ NO CREDENTIAL IS WRITTEN IN THIS FILE. It is committed, and the account it
   opens is a real one — the same login works against whatever database
   `npm run dev` points at. Taken from your gitignored .env when set, otherwise
   generated fresh each boot and printed in the banner below. */
/* ⚠ Needs a DOT in the domain — the User model validates against /\S+@\S+\.\S+/,
   so the obvious "dev@localhost" fails validation and takes the boot down with
   it before the port ever opens. */
const EMAIL = process.env.ADMIN_EMAIL || "dev@iwan.local";
const USERNAME = process.env.ADMIN_USERNAME || "dev";
const PASSWORD = process.env.ADMIN_PASSWORD || randomBytes(9).toString("base64url");
const GENERATED = !process.env.ADMIN_PASSWORD;

const mongod = await MongoMemoryServer.create();

process.env.NODE_ENV = "development";
process.env.MONGODB_URI = mongod.getUri("iwan_cms_dev_memory");
process.env.JWT_SECRET ??= "local-development-only-not-a-real-secret";
/* Empty in development means "any origin" — see app.js. */
process.env.CORS_ORIGINS ??= "";

const { connectDb } = await import("../src/db.js");
const { createApp } = await import("../src/app.js");
const { User } = await import("../src/models/User.js");
const { CONFIG } = await import("../src/config.js");

await connectDb();

await User.create({
  email: EMAIL,
  username: USERNAME,
  name: "Admin",
  passwordHash: await User.hashPassword(PASSWORD),
  role: "admin",
});

/* Seeded in-process, so the data is there before the port opens.

   ⚠ The content comes from the PUBLIC SITE's own files, which live in a
   different repository — `--from` says where. Pass it through so this can be
   pointed at wherever that repo is checked out:

     npm run dev:memory -- --from=../../new-iwan/src/content/base

   ⚠ A MISSING SOURCE IS NOT FATAL. The whole point of this script is to get a
   working API up with no Atlas and no setup; refusing to boot because a sibling
   repo is somewhere else would defeat that. It says so and carries on with an
   empty database — the admin still works, and content can be created in the
   CMS by hand. */
const { seedInto } = await import("./seed-lib.js");

const fromArg = process.argv.find((a) => a.startsWith("--from="));

let counts = { events: 0, blogs: 0, episodes: 0, promos: 0 };
let seedError = "";

try {
  counts = await seedInto(fromArg ? { source: fromArg.slice("--from=".length) } : {});
} catch (err) {
  seedError = err.message.split("\n")[0];
}

/* ⚠ ONE DEMO EVENT WHEN THERE IS NOTHING TO REGISTER FOR. The public site no
   longer ships events, blogs, podcast or promo — they come from this API now —
   so there is usually nothing for `seedInto` to read and the database comes up
   empty. An empty database cannot exercise the one route the public can write
   to, which is the thing most worth trying locally.

   ⚠ INVENTED CONTENT, and safe only because this script cannot touch a real
   database: it runs against the throwaway in-memory server started above and
   nothing else. It is skipped the moment there is a real event. */
const { Event } = await import("../src/models/Event.js");

if ((await Event.countDocuments({})) === 0) {
  await Event.create({
    slug: "demo-event",
    status: "published",
    title: "Demo Event (local only)",
    countries: [],
    date: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10),
    start: "18:30",
    end: "20:30",
    venue: "Iwan Hall",
    address: "14 Main Street, Bangalore",
    summary: "Created by dev:memory so the registration form has something to post to.",
    /* The smallest form the API will accept on a published event: it must ask
       for an email, or a registration reaches nobody. */
    form: [
      { key: "name", label: "Your name", type: "name", required: true },
      { key: "email", label: "Email", type: "email", required: true },
    ],
  });
}

createApp().listen(CONFIG.port, () => {
  console.log(`
┌─ iwan-cms-api (in-memory) ────────────────────────────────
│  http://localhost:${CONFIG.port}
│
│  ${
    seedError
      ? `⚠ NOT SEEDED — ${seedError}
│    The public site no longer ships events — a demo one is created instead.`
      : `Seeded: ${counts.events} events · ${counts.blogs} posts · ${counts.episodes} episodes · ${counts.promos} promos`
  }
│
│  Sign in with
│    ${USERNAME}   (or ${EMAIL})
│    ${PASSWORD}${GENERATED ? "   ← generated; set ADMIN_PASSWORD in .env to fix it" : ""}
│
│  ⚠ Everything is lost when this process stops.
└───────────────────────────────────────────────────────────
`);
});

const stop = async () => {
  await mongod.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
