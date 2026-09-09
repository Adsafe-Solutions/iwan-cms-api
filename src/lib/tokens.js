import jwt from "jsonwebtoken";
import { CONFIG } from "../config.js";

/* Stateless sessions: nothing is stored server-side, so there is no session
   collection to grow and no logout that can fail. ⚠ The cost is that a token
   cannot be revoked before it expires — deactivation is covered by re-reading
   `active` on each request, see middleware/auth.js. */
export const signToken = (user) =>
  jwt.sign({ sub: String(user._id), role: user.role }, CONFIG.jwtSecret, {
    expiresIn: CONFIG.jwtExpiresIn,
  });

export const verifyToken = (token) => jwt.verify(token, CONFIG.jwtSecret);

/* The only place a token is accepted. ⚠ Deliberately not a cookie: a header
   keeps this immune to CSRF without a token dance. */
export const bearerFrom = (req) => {
  const header = req.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
};

/* ── unsubscribe links ───────────────────────────────────────────────────── */

/* ⚠ A SIGNED TOKEN, never the raw address. `?email=someone@example.com` in an
   unsubscribe link means anyone can unsubscribe anyone by typing an address,
   and every such link that ends up in a log or a referrer header carries a real
   person's address with it.

   ⚠ NO EXPIRY, deliberately. People unsubscribe from the oldest mail in the
   pile, and a link that says "this has expired" is a link that failed at the
   one job it had — the recipient does not try again, they mark it as spam,
   which is far worse for the sending domain than an old token being valid.
   `purpose` is what stops a session token being spent here and the other way
   round; nothing else this key signs carries it. */
export const signUnsubscribe = (email) =>
  jwt.sign(
    { purpose: "unsubscribe", email: String(email).toLowerCase() },
    CONFIG.jwtSecret
  );

/* Returns the address, or null for anything that is not a valid unsubscribe
   token — expired, forged, signed by a different key, or a session token. */
export const readUnsubscribe = (token) => {
  try {
    const claims = jwt.verify(String(token ?? ""), CONFIG.jwtSecret);
    if (claims?.purpose !== "unsubscribe" || !claims.email) return null;
    return String(claims.email).toLowerCase();
  } catch {
    return null;
  }
};

/* The link that goes in an email. ⚠ Empty when API_URL is unset — there is no
   honest way to guess this API's public address from inside it, and a link to
   localhost in someone's inbox is worse than no link at all. mail.js drops the
   footer and the headers when this is empty. */
export const unsubscribeUrl = (email) =>
  CONFIG.apiUrl && email
    ? `${CONFIG.apiUrl}/api/unsubscribe?t=${encodeURIComponent(signUnsubscribe(email))}`
    : "";
