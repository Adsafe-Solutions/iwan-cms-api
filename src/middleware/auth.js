import { User } from "../models/User.js";
import { forbidden, unauthorized, wrap } from "../lib/errors.js";
import { bearerFrom, verifyToken } from "../lib/tokens.js";

/* Verifies the bearer token and loads the account behind it.

   ⚠ The user is re-read from the database on every request rather than trusted
   from the token's claims. That is one indexed lookup, and it is what makes
   deactivating an account or changing its role take effect immediately instead
   of whenever the token happens to expire. */
export const requireAuth = wrap(async (req, _res, next) => {
  const token = bearerFrom(req);
  if (!token) throw unauthorized();

  let claims;
  try {
    claims = verifyToken(token);
  } catch {
    /* Expired and malformed are the same answer on purpose — telling a caller
       which one it was is free information for someone probing. */
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

/* Whether an account may write content for a given set of countries.

   An `admin` may write anything. An `editor` with an EMPTY `countries` list is
   likewise unscoped — that is the same "means everywhere" convention content
   documents use. A scoped editor may only touch documents whose countries are a
   subset of their own, which also means they cannot create or edit a GLOBAL
   document: a global one shows in every country, including the ones they do not
   have. Widening a document to a country they lack is refused for the same
   reason. */
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
