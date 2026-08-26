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
