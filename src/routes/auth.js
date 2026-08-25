import { Router } from "express";
import rateLimit from "express-rate-limit";
import { User } from "../models/User.js";
import { signToken } from "../lib/tokens.js";
import { unauthorized, wrap } from "../lib/errors.js";
import { validate } from "../middleware/validate.js";
import { requireAuth } from "../middleware/auth.js";
import { adminUser } from "../lib/serialize.js";
import { loginInput, passwordChangeInput } from "../validators/content.js";

const router = Router();

/* Password guessing is the only unauthenticated write path in this API, so it
   is the only one worth rate limiting. Ten attempts per IP per fifteen minutes
   is far beyond a person mistyping their own password and far below anything
   useful to a script.
   ⚠ Behind Render's proxy this needs `trust proxy` set on the app, or every
   request appears to come from the same address and the limit becomes global —
   see app.js. */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts — try again in a few minutes" },
});

router.post(
  "/login",
  loginLimiter,
  validate(loginInput),
  wrap(async (req, res) => {
    const { email: identifier, password } = req.body;

    /* An "@" is what tells the two apart. Nothing else does — a username is
       deliberately not allowed to contain one (see the model's pattern), so
       this cannot be ambiguous. */
    const where = identifier.includes("@")
      ? { email: identifier }
      : { username: identifier };

    /* `passwordHash` is `select: false` on the model, so it has to be asked
       for by name — that is what stops it leaking from any other query. */
    const user = await User.findOne(where).select("+passwordHash");

    /* ⚠ One message for "no such account", "wrong password" and "deactivated".
       Distinguishing them tells someone probing which addresses are real. The
       comparison still runs when the account is missing so the response time
       does not answer the question either. */
    const ok = user
      ? await user.verifyPassword(password)
      : await User.hashPassword(password).then(() => false);

    if (!ok || !user.active) throw unauthorized("Wrong email or password");

    user.lastLoginAt = new Date();
    await user.save();

    res.json({ token: signToken(user), user: adminUser(user) });
  })
);

/* Who the current token belongs to. The admin calls this on boot to decide
   whether a stored token is still good, and to know which countries the
   signed-in editor may write to. */
router.get("/me", requireAuth, (req, res) => {
  res.json({ user: adminUser(req.user) });
});

router.post(
  "/change-password",
  requireAuth,
  validate(passwordChangeInput),
  wrap(async (req, res) => {
    const user = await User.findById(req.user._id).select("+passwordHash");
    const ok = await user.verifyPassword(req.body.currentPassword);
    if (!ok) throw unauthorized("Your current password is not right");

    user.passwordHash = await User.hashPassword(req.body.newPassword);
    await user.save();

    /* ⚠ Existing tokens stay valid — they are stateless and nothing revokes
       them. A password change locks out someone who only knew the password,
       not someone already holding a token. Revocation would mean a token
       version on the user and a check on every request; worth adding the day
       these accounts protect anything more than marketing copy. */
    res.json({ ok: true });
  })
);

export default router;
