import jwt from "jsonwebtoken";
import { CONFIG } from "../config.js";

/* Stateless sessions: the token carries the user id and is verified on every
   request. Nothing is stored server-side, so there is no session collection to
   grow and no logout endpoint that can fail — the admin drops the token and the
   session is over. The cost is that a token cannot be revoked before it expires;
   deactivating an account is handled by re-reading `active` from the database on
   each request (see middleware/auth.js), which covers the case that matters. */
export const signToken = (user) =>
  jwt.sign({ sub: String(user._id), role: user.role }, CONFIG.jwtSecret, {
    expiresIn: CONFIG.jwtExpiresIn,
  });

export const verifyToken = (token) => jwt.verify(token, CONFIG.jwtSecret);

/* "Authorization: Bearer <token>" — the only place a token is accepted. It is
   deliberately not read from a cookie: the admin is a separate origin from the
   API, and a header keeps this immune to CSRF without a token dance. */
export const bearerFrom = (req) => {
  const header = req.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
};
