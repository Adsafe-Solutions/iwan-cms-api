import { Router } from "express";
import { crudRouter } from "./crud.js";
import registrationRoutes from "./registrations.js";
import { Event } from "../models/Event.js";
import { Blog } from "../models/Blog.js";
import { PodcastEpisode, PodcastShow } from "../models/Podcast.js";
import { Promo } from "../models/Promo.js";
import { User } from "../models/User.js";
import {
  adminBlog,
  adminEpisode,
  adminEvent,
  adminPromo,
  adminShow,
  adminUser,
} from "../lib/serialize.js";
import {
  assertEventIsSound,
  assertPromoWindow,
  blogInput,
  episodeInput,
  eventInput,
  promoInput,
  showInput,
  userInput,
} from "../validators/content.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { badRequest, notFound, wrap } from "../lib/errors.js";
import { COUNTRY_CODES } from "../lib/countries.js";

/* Everything behind a sign-in. Mounted at /api/admin, and `requireAuth` is
   applied to the whole router rather than route by route, so a new route added
   below cannot be left unprotected by forgetting a middleware. */

const router = Router();

router.use(requireAuth);

/* What the admin UI needs to render its forms without hard-coding any of it:
   the country codes this API accepts, and the programme paths an event or post
   can be filed under.

   ⚠ The programme list is a copy of the public site's content/base/nav.js. It
   lives here so the admin's dropdown and the API's validation agree, and it has
   to be updated alongside the site when a programme is added or renamed —
   a path that does not match a nav entry renders as an unfiled item rather than
   failing loudly. */
const PROGRAMMES = [
  { path: "/iwan-men", label: "Iwan Men" },
  { path: "/iwan-women", label: "Iwan Women" },
  { path: "/iwan-youth", label: "Iwan Youth" },
  { path: "/iwan-kids", label: "Iwan Kids" },
];

router.get("/meta", (_req, res) => {
  res.json({
    countries: COUNTRY_CODES,
    programmes: PROGRAMMES,
    statuses: ["draft", "published"],
  });
});

/* ── content ────────────────────────────────────────────────────────────── */

router.use(
  "/events",
  crudRouter({
    model: Event,
    schema: eventInput,
    serialize: adminEvent,
    /* Soonest first: the events an editor is most likely to be touching are the
       ones that have not happened yet. */
    sort: { date: 1 },
    searchFields: ["title", "slug", "venue"],
    /* Runs on the MERGED event, so a PATCH that only flips `status` to
       published is still checked against the form already stored. */
    beforeSave: assertEventIsSound,
  })
);

router.use(
  "/blogs",
  crudRouter({
    model: Blog,
    schema: blogInput,
    serialize: adminBlog,
    sort: { date: -1, updatedAt: -1 },
    searchFields: ["title", "slug", "excerpt"],
  })
);

router.use(
  "/episodes",
  crudRouter({
    model: PodcastEpisode,
    schema: episodeInput,
    serialize: adminEpisode,
    sort: { order: 1, createdAt: 1 },
    searchFields: ["title", "slug", "author"],
  })
);

router.use(
  "/promos",
  crudRouter({
    model: Promo,
    schema: promoInput,
    serialize: adminPromo,
    sort: { priority: -1, updatedAt: -1 },
    searchFields: ["name", "slug", "heading"],
    /* The one rule the shared schema cannot express — and it is checked on the
       MERGED document, so a PATCH that moves only one end of the window is
       caught too. */
    beforeSave: assertPromoWindow,
  })
);

/* The show is a singleton, so it gets GET/PUT rather than a CRUD router — there
   is nothing to list and nothing to create. `upsert` means the first save
   creates it, which is why there is no separate "set up the podcast" step. */
router
  .route("/podcast/show")
  .get(
    wrap(async (_req, res) => {
      const show = await PodcastShow.findOne({ key: "show" }).lean();
      res.json(adminShow(show));
    })
  )
  .put(
    validate(showInput),
    wrap(async (req, res) => {
      const show = await PodcastShow.findOneAndUpdate({ key: "show" }, req.body, {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      }).lean();
      res.json(adminShow(show));
    })
  );

router.use("/registrations", registrationRoutes);

/* ── accounts ───────────────────────────────────────────────────────────── */

/* Admins only: an editor who could create accounts could create an unscoped one
   and step straight around their own country scope. */
router.use("/users", requireAdmin);

router.get(
  "/users",
  wrap(async (_req, res) => {
    const users = await User.find().sort({ createdAt: 1 }).lean();
    res.json({ items: users.map(adminUser), total: users.length });
  })
);

router.post(
  "/users",
  validate(userInput),
  wrap(async (req, res) => {
    const { password, ...rest } = req.body;
    const user = await User.create({
      ...rest,
      passwordHash: await User.hashPassword(password),
    });
    res.status(201).json(adminUser(user));
  })
);

router.patch(
  "/users/:id",
  validate(userInput, { partial: true }),
  wrap(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) throw notFound("No such user");

    const { password, ...rest } = req.body;

    /* ⚠ Locking yourself out is one API call away otherwise: deactivating your
       own account, or demoting the last admin, leaves nobody who can undo it.
       Both are refused here rather than left as a support problem. */
    if (String(user._id) === String(req.user._id)) {
      if (rest.active === false) throw badRequest("You cannot deactivate yourself");
      if (rest.role && rest.role !== "admin") {
        throw badRequest("You cannot remove your own admin role");
      }
    }

    if (rest.role === "editor" || rest.active === false) {
      const admins = await User.countDocuments({ role: "admin", active: true });
      if (admins <= 1 && user.role === "admin" && user.active) {
        throw badRequest("This is the last active admin");
      }
    }

    user.set(rest);
    if (password) user.passwordHash = await User.hashPassword(password);
    await user.save();

    res.json(adminUser(user));
  })
);

router.delete(
  "/users/:id",
  wrap(async (req, res) => {
    if (String(req.params.id) === String(req.user._id)) {
      throw badRequest("You cannot delete your own account");
    }
    const user = await User.findById(req.params.id);
    if (!user) throw notFound("No such user");

    if (user.role === "admin") {
      const admins = await User.countDocuments({ role: "admin", active: true });
      if (admins <= 1) throw badRequest("This is the last active admin");
    }

    await user.deleteOne();
    res.status(204).end();
  })
);

export default router;
