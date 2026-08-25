import mongoose from "mongoose";
import bcrypt from "bcryptjs";

export const ROLES = ["admin", "editor"];

/* A CMS editor. There is no public sign-up — accounts are made by an admin (or
   by scripts/create-admin.js for the very first one), so there is no
   verification flow, no password reset and nothing self-service here yet. */
const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, "An email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "That is not an email address"],
    },
    /* An optional short handle to sign in with, as an alternative to the email.
       ⚠ `sparse` is what makes the unique index tolerate many accounts with no
       username at all — without it, the second account leaving this blank would
       collide with the first on a null value. */
    username: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
      default: undefined,
      match: [/^[a-z0-9._-]{3,32}$/, "Use 3-32 letters, numbers, . _ or -"],
    },

    name: { type: String, trim: true, default: "" },

    /* ⚠ `select: false`, so a plain `User.find()` can never leak hashes into a
       response by accident. Anything that needs to verify a password has to ask
       for it explicitly (`.select("+passwordHash")`). */
    passwordHash: { type: String, required: true, select: false },

    role: { type: String, enum: ROLES, default: "editor" },

    /* Which countries this account may edit. EMPTY means every country, the
       same convention content documents use. An `admin` ignores it outright. */
    countries: {
      type: [{ type: String, lowercase: true, trim: true }],
      default: [],
    },

    active: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/* Cost 12: ~250ms per hash on current hardware. Slow enough to make an offline
   attack on a stolen dump expensive, fast enough that a login still feels
   instant. */
const ROUNDS = 12;

userSchema.statics.hashPassword = (plain) => bcrypt.hash(plain, ROUNDS);

userSchema.methods.verifyPassword = function verifyPassword(plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

export const User = mongoose.model("User", userSchema);

export default User;
