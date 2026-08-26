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
  assertEpisodePlayable,
  assertEventIsSound,
  assertPromoWindow,
  blogInput,
  episodeInput,
  eventInput,
  promoInput,
  showInput,
  userInput,
} from "../validators/content.js";
import { requireAdmin, requireAuth, requireWriter } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { badRequest, notFound, wrap } from "../lib/errors.js";
import { COUNTRY_CODES } from "../lib/countries.js";

/* Everything behind a sign-in. `requireAuth` is applied to the whole router
   rather than route by route, so a new route cannot be left unprotected. */

const router = Router();

router.use(requireAuth);
/* ⚠ Before any route, so no route has to restate it. */
router.use(requireWriter);

/* What the admin needs to render its forms without hard-coding any of it.

   ⚠ The programme list is a copy of the site's content/base/nav.js, kept here
   so the admin's dropdown and the API's validation agree. It has to be updated
   alongside the site: an unmatched path renders as unfiled rather than
   failing loudly. */
/* ⚠ `color` is the programme's own colour from the SITE's tailwind.config.js
   palette, copied here so the CMS can tint a programme pill with it. It has to
   be updated alongside the site, like the paths and labels above it. Served as
   a hex because the admin's Tailwind knows nothing about these four. */
const PROGRAMMES = [
  { path: "/iwan-men", label: "Iwan Men", color: "#234967" },
  { path: "/iwan-women", label: "Iwan Women", color: "#ee5f9e" },
  { path: "/iwan-youth", label: "Iwan Youth", color: "#3994b3" },
  { path: "/iwan-kids", label: "Iwan Kids", color: "#3694db" },
];

router.get("/meta", (_req, res) => {
  res.json({
    countries: COUNTRY_CODES,
    programmes: PROGRAMMES,
    statuses: ["draft", "published"],
  });
});

router.use(
  "/events",
  crudRouter({
    model: Event,
    schema: eventInput,
    serialize: adminEvent,
    /* Soonest first — the ones an editor is most likely to be touching. */
    sort: { date: 1 },
    searchFields: ["title", "slug", "venue"],
    /* Runs on the MERGED event, so a PATCH flipping only `status` is still
       checked against the form already stored. */
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
    beforeSave: assertEpisodePlayable,
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
    /* The one rule the shared schema cannot express, checked on the MERGED
       document so a PATCH moving one end of the window is caught. */
    beforeSave: assertPromoWindow,
  })
);

/* A singleton, so GET/PUT rather than a CRUD router. `upsert` means the first
   save creates it, hence no separate "set up the podcast" step. */
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

/* Admins only: an editor who could create accounts could create an unscoped
   one and step around their own country scope. */
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

    /* ⚠ Deactivating yourself or demoting the last admin leaves nobody who can
       undo it. Refused here rather than left as a support problem. */
    if (String(user._id) === String(req.user._id)) {
      if (rest.active === false) throw badRequest("You cannot deactivate yourself");
      if (rest.role && rest.role !== "admin") {
        throw badRequest("You cannot remove your own admin role");
      }
    }

    /* ⚠ Any role that is NOT admin — naming them one by one stops covering the
       next role added. Backstop; the self-check above is what fires. */
    if ((rest.role && rest.role !== "admin") || rest.active === false) {
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
