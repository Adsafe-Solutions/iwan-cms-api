import { User } from "../models/User.js";
import { forbidden, unauthorized, wrap } from "../lib/errors.js";
import { bearerFrom, verifyToken } from "../lib/tokens.js";

/* Verifies the bearer token and loads the account behind it.

   ⚠ Re-read from the database every request rather than trusted from the
   token's claims — one indexed lookup, and what makes deactivating an account
   take effect immediately rather than whenever the token expires. */
export const requireAuth = wrap(async (req, _res, next) => {
  const token = bearerFrom(req);
  if (!token) throw unauthorized();

  let claims;
  try {
    claims = verifyToken(token);
  } catch {
    /* Expired and malformed give the same answer — the difference is free
       information for someone probing. */
    throw unauthorized("Session expired or invalid");
  }

  const user = await User.findById(claims.sub);
  if (!user || !user.active) throw unauthorized("Account is no longer active");

  req.user = user;
  next();
});

export const requireAdmin = (req, _res, next) => {
  if (req.user?.role !== "admin") throw forbidden("Admins only");
  next();
};

/* Whether an account may write for a set of countries. An admin, or an editor
   with an EMPTY list, is unscoped. A scoped editor may only touch documents
   whose countries are a subset of their own — which also bars them from GLOBAL
   documents, since those show in countries they do not have. */
export const assertCountryScope = (user, countries = []) => {
  if (user.role === "admin") return;
  if (!user.countries || user.countries.length === 0) return;

  if (countries.length === 0) {
    throw forbidden(
      "Only an unscoped editor can publish to every country — pick the countries this belongs to"
    );
  }

  const outside = countries.filter((c) => !user.countries.includes(c));
  if (outside.length) {
    throw forbidden(`You cannot publish to: ${outside.join(", ")}`);
  }
};
