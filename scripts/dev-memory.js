/* Boots the API against a throwaway in-memory MongoDB, seeds it from the public
   site's content and creates a dev admin — so the whole stack runs with no
   Atlas cluster, no connection string and no account setup.

     npm run dev:memory

   ⚠ Everything is gone when the process stops. This is for local work and demos
   only; anything you want to keep needs a real MONGODB_URI and `npm run dev`.

   The credentials are printed on boot and are deliberately fixed, so the login
   screen can be filled in without hunting for them. `config.js` refuses to run
   in production without a real secret, which is what stops this being reachable
   from a deployed build. */

import "dotenv/config";
import { randomBytes } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";

/* ⚠ NO CREDENTIAL IS WRITTEN IN THIS FILE.

   It is committed, so anything hard-coded here is published — and worse, the
   account it opens is a real one, because the same login is used against
   whatever database `npm run dev` points at.

   So: taken from the environment when set (your gitignored .env), and otherwise
   GENERATED FRESH each boot and printed in the banner below. A generated one
   changes every restart, which is mildly annoying and exactly the nudge to put
   your own in .env.

   The email and username are not secrets, but they are defaulted to something
   obviously local rather than to a real account. */
const EMAIL = process.env.ADMIN_EMAIL || "dev@localhost";
const USERNAME = process.env.ADMIN_USERNAME || "dev";
const PASSWORD = process.env.ADMIN_PASSWORD || randomBytes(9).toString("base64url");
const GENERATED = !process.env.ADMIN_PASSWORD;

const mongod = await MongoMemoryServer.create();

process.env.NODE_ENV = "development";
process.env.MONGODB_URI = mongod.getUri("iwan_cms_dev_memory");
process.env.JWT_SECRET ??= "local-development-only-not-a-real-secret";
/* Empty in development means "any origin" — see app.js. The admin runs on 5174
   and the public site on 5173, and a demo may run on neither. */
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

/* Seeded in-process rather than by shelling out, so the data is there before
   the port opens and the first page load is never of an empty CMS. */
const { seedInto } = await import("./seed-lib.js");
const counts = await seedInto();

createApp().listen(CONFIG.port, () => {
  console.log(`
┌─ iwan-cms-api (in-memory) ────────────────────────────────
│  http://localhost:${CONFIG.port}
│
│  Seeded: ${counts.events} events · ${counts.blogs} posts · ${counts.episodes} episodes · ${counts.promos} promos
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
