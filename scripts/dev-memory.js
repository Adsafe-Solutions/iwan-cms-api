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
const EMAIL = process.env.ADMIN_EMAIL || "dev@localhost";
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

/* Seeded in-process, so the data is there before the port opens. */
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
