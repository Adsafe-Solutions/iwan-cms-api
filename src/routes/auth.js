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

/* Ten attempts per IP per fifteen minutes: far beyond someone mistyping their
   own password, far below anything useful to a script. ⚠ Needs `trust proxy`
   on the app, or the limit becomes one global bucket — see app.js. */
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

    /* An "@" tells the two apart — a username may not contain one, so this
       cannot be ambiguous. */
    const where = identifier.includes("@")
      ? { email: identifier }
      : { username: identifier };

    /* `select: false` on the model, so it must be asked for by name — which is
       what stops it leaking from every other query. */
    const user = await User.findOne(where).select("+passwordHash");

    /* ⚠ One message for all three failures — distinguishing them tells someone
       probing which addresses are real. The comparison still runs for a missing
       account so the response time does not answer it either. */
    const ok = user
      ? await user.verifyPassword(password)
      : await User.hashPassword(password).then(() => false);

    if (!ok || !user.active) throw unauthorized("Wrong email or password");

    user.lastLoginAt = new Date();
    await user.save();

    res.json({ token: signToken(user), user: adminUser(user) });
  })
);

/* Who the token belongs to. The admin calls this on boot to decide whether a
   stored token is still good. */
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

    /* ⚠ Existing tokens stay valid — they are stateless, so a password change
       locks out someone who knew the password, not someone already holding a
       token. Revocation would mean a token version checked on every request. */
    res.json({ ok: true });
  })
);

export default router;
