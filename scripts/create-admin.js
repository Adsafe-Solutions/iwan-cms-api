import mongoose from "mongoose";
import { assertConfig, isProduction } from "../src/config.js";
import { connectDb, disconnectDb } from "../src/db.js";
import { User } from "../src/models/User.js";

const email = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
const username = (process.env.ADMIN_USERNAME ?? "").trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD ?? "";
const name = process.env.ADMIN_NAME ?? "Iwan Admin";

async function main() {
  assertConfig();

  if (!email || !password) {
    throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD");
  }
  /* ⚠ The 10-character floor is enforced in PRODUCTION only.

     Locally, a memorable throwaway password is worth more than a strong one:
     the database is a dev database, the API is on localhost, and a floor that
     makes people paste a random string into a chat window to share it is not
     buying security. In production the same floor is absolute — that account
     guards the live site's content and has no second factor behind it. */
  const floor = isProduction ? 10 : 6;
  if (password.length < floor) {
    throw new Error(
      `ADMIN_PASSWORD must be at least ${floor} characters` +
        (isProduction ? "" : " (10 in production)")
    );
  }

  if (!isProduction && password.length < 10) {
    console.warn(
      `[create-admin] ⚠ "${password}" is short and would be refused in production.`
    );
  }

  await connectDb();

  const passwordHash = await User.hashPassword(password);
  const existing = await User.findOne({ email });

  if (existing) {
    existing.set({
      passwordHash,
      role: "admin",
      active: true,
      countries: [],
      ...(username ? { username } : {}),
    });
    await existing.save();
    console.log(`[create-admin] reset the password for ${email}`);
  } else {
    await User.create({
      email,
      ...(username ? { username } : {}),
      name,
      passwordHash,
      role: "admin",
      /* Empty: an admin is unscoped and may edit every country. */
      countries: [],
      active: true,
    });
    console.log(
      `[create-admin] created ${email}${username ? ` (sign in as "${username}")` : ""}`
    );
  }

  await disconnectDb();
}

main().catch(async (err) => {
  console.error(`[create-admin] failed: ${err.message}`);
  if (mongoose.connection.readyState === 1) await disconnectDb();
  process.exit(1);
});
