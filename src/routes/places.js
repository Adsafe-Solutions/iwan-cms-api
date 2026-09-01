import { Router } from "express";
import rateLimit from "express-rate-limit";
import { search, MIN_QUERY } from "../lib/geocode.js";
import { isCountryCode } from "../lib/countries.js";
import { wrap } from "../lib/errors.js";

/* GET /api/admin/places?q=…&country=… — address search for the CMS.

   ⚠ A PROXY, and that is the point. The geocoder is called from here rather
   than from the browser so that a provider needing a key (Google, Mappls)
   can be swapped in without that key ever reaching the CMS bundle, where it
   would be publicly readable. Mounted under the admin router, so it is behind
   the sign-in and only editors can spend the quota. */

const router = Router();

/* An editor types, so requests arrive in bursts of one per keystroke even
   with the browser debouncing. Generous, but not unbounded. */
const searchLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many address searches. Try again in a moment." },
});

router.get(
  "/",
  searchLimiter,
  wrap(async (req, res) => {
    const q = String(req.query.q ?? "");
    const country = String(req.query.country ?? "").toLowerCase();

    /* ⚠ Empty list, not a 400. A half-typed query is the normal state of a
       search box, not a caller error — the field asks on every keystroke. */
    if (q.trim().length < MIN_QUERY) {
      return res.json({ items: [], query: q });
    }

    const items = await search(q, isCountryCode(country) ? country : undefined);
    /* Never cached: a search result is per-keystroke and per-editor, and the
       admin API is not behind a shared cache anyway. */
    res.json({ items, query: q });
  })
);

export default router;
