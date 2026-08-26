import mongoose from "mongoose";
import bcrypt from "bcryptjs";

/* The one list of roles; validators/content.js reads it too. */
export const ROLES = ["admin", "editor", "viewer"];

/* ⚠ An explicit list, not "not an admin" — a role added above must be named
   here to lose its write access, never the other way round. */
export const READ_ONLY_ROLES = ["viewer"];

/* A CMS editor. No public sign-up: accounts are made by an admin, or by
   scripts/create-admin.js for the first one. */
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
    /* ⚠ `sparse` is what lets the unique index tolerate many accounts with no
       username — without it the second blank collides with the first. */
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

    /* ⚠ `select: false`, so a plain `User.find()` cannot leak hashes. Asking
       for it takes an explicit `.select("+passwordHash")`. */
    passwordHash: { type: String, required: true, select: false },

    role: { type: String, enum: ROLES, default: "editor" },

    /* EMPTY means every country, as everywhere else. `admin` ignores it. */
    countries: {
      type: [{ type: String, lowercase: true, trim: true }],
      default: [],
    },

    active: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/* Cost 12 — ~250ms per hash: expensive to attack offline, instant to a user. */
const ROUNDS = 12;

userSchema.statics.hashPassword = (plain) => bcrypt.hash(plain, ROUNDS);

userSchema.methods.verifyPassword = function verifyPassword(plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

export const User = mongoose.model("User", userSchema);

export default User;
