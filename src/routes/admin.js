import { Router } from "express";
import { crudRouter } from "./crud.js";
import registrationRoutes from "./registrations.js";
import audienceRoutes, { applicationRouter } from "./audience.js";
import uploadRoutes from "./uploads.js";
import placeRoutes from "./places.js";
import { Event } from "../models/Event.js";
import { Blog } from "../models/Blog.js";
import { PodcastEpisode, PodcastShow } from "../models/Podcast.js";
import { Promo } from "../models/Promo.js";
import { ApplyForm } from "../models/ApplyForm.js";
import { activateApplyForm } from "../lib/applyForms.js";
import { APPLICATION_KINDS } from "../models/Application.js";
import { User } from "../models/User.js";
import {
  adminBlog,
  adminEpisode,
  adminEvent,
  adminPromo,
  adminShow,
  adminApplyForm,
  adminUser,
} from "../lib/serialize.js";
import {
  assertEpisodePlayable,
  applyFormInput,
  assertApplyFormIsSound,
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
    /* ⚠ Newest first, NOT the site's upcoming-first order. The admin list
       spans every event ever run, so date-ascending opened on the oldest one
       an editor will never touch again. */
    sort: { date: -1, updatedAt: -1 },
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
    /* Highest running order first — the latest episode. The SITE still lists
       them ascending, which is what `order` is for; this is only the desk. */
    sort: { order: -1, createdAt: -1 },
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

/* The volunteer and career question sets. Two singletons keyed by kind, so
   GET/PUT rather than a CRUD router — the same shape as the podcast show. */
/* The volunteer and career forms. A list, so this is ordinary CRUD plus one
   extra verb: activating. */
router.get(
  "/apply-forms",
  wrap(async (req, res) => {
    const where = APPLICATION_KINDS.includes(req.query.kind)
      ? { kind: req.query.kind }
      : {};
    const items = await ApplyForm.find(where).sort({ kind: 1, updatedAt: -1 }).lean();
    res.json({ items: items.map(adminApplyForm), total: items.length });
  })
);

router.post(
  "/apply-forms",
  validate(applyFormInput),
  wrap(async (req, res) => {
    assertApplyFormIsSound(req.body);
    const doc = await ApplyForm.create(req.body);
    res.status(201).json(adminApplyForm(doc.toObject()));
  })
);

router.get(
  "/apply-forms/:id",
  wrap(async (req, res) => {
    const doc = await ApplyForm.findById(req.params.id).lean();
    if (!doc) throw notFound("No such form");
    res.json(adminApplyForm(doc));
  })
);

router.put(
  "/apply-forms/:id",
  validate(applyFormInput),
  wrap(async (req, res) => {
    assertApplyFormIsSound(req.body);

    const doc = await ApplyForm.findById(req.params.id);
    if (!doc) throw notFound("No such form");

    doc.set(req.body);
    await doc.save();

    /* ⚠ Re-run if this one is live: editing its countries can put it back in
       competition with another active form, and two live forms make "which one
       does Canada see" unanswerable. */
    if (doc.active) await activateApplyForm(doc);

    res.json(adminApplyForm(doc.toObject()));
  })
);

/* ⚠ The one that enforces "one active at a time". Deactivating the others is
   part of activating THIS one, not a separate call an editor could forget. */
router.post(
  "/apply-forms/:id/activate",
  wrap(async (req, res) => {
    const doc = await ApplyForm.findById(req.params.id).lean();
    if (!doc) throw notFound("No such form");

    if (!(doc.fields ?? []).length) {
      throw badRequest("A form with no questions cannot go live", [
        { field: "fields", message: "Add at least one question first." },
      ]);
    }
    assertApplyFormIsSound(doc);

    const displaced = await activateApplyForm(doc);
    const fresh = await ApplyForm.findById(req.params.id).lean();
    res.json({ ...adminApplyForm(fresh), displaced });
  })
);

router.post(
  "/apply-forms/:id/deactivate",
  wrap(async (req, res) => {
    const doc = await ApplyForm.findByIdAndUpdate(
      req.params.id,
      { $set: { active: false } },
      { new: true }
    ).lean();
    if (!doc) throw notFound("No such form");
    res.json(adminApplyForm(doc));
  })
);

router.delete(
  "/apply-forms/:id",
  wrap(async (req, res) => {
    const doc = await ApplyForm.findById(req.params.id);
    if (!doc) throw notFound("No such form");

    /* ⚠ Refused while live, or the page loses its form to a click meant as
       tidying up. Deactivate first, which is a deliberate second step. */
    if (doc.active) {
      throw badRequest("This form is live — turn it off before deleting it");
    }

    /* ⚠ The default is the floor under everything else: delete it and a
       deployment with no custom form has nothing at all. Turning it off is
       allowed — that is a deliberate "we are not taking applications". */
    if (doc.isDefault) {
      throw badRequest(
        "This is the default form and cannot be deleted. Turn it off instead."
      );
    }

    await doc.deleteOne();
    res.status(204).end();
  })
);

router.use("/registrations", registrationRoutes);
router.use("/audience", audienceRoutes);
router.use("/applications", applicationRouter);
router.use("/uploads", uploadRoutes);
router.use("/places", placeRoutes);

/* Admins only: an editor who could create accounts could create an unscoped
   one and step around their own country scope. */
router.use("/users", requireAdmin);

router.get(
  "/users",
  wrap(async (_req, res) => {
    const users = await User.find().sort({ createdAt: -1 }).lean();
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
