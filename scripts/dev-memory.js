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
import { MongoMemoryServer } from "mongodb-memory-server";

/* ⚠ NOT the real password. This file is committed, so a credential written
   here is a published credential — and the account it opens is a real one on
   whatever database `npm run dev` is pointed at, because the same login is used
   for both by design.

   The default below is deliberately obvious rubbish. Set ADMIN_PASSWORD in your
   (gitignored) .env to use your actual one and keep the two in step. */
const EMAIL = process.env.ADMIN_EMAIL || "admin2026@iwan.community";
const USERNAME = process.env.ADMIN_USERNAME || "admin2026";
const PASSWORD = process.env.ADMIN_PASSWORD || "dev-only-not-a-real-password";

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
│    ${PASSWORD}
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
