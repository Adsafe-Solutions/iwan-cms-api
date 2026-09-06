/* End-to-end smoke test against a throwaway in-memory MongoDB. No test runner:
   it boots the real app, seeds real content, writes through the admin routes
   and reads back through the public ones, asserting the public side is the
   shape the site's components expect.

     npm run smoke

   ⚠ The first run downloads a mongod binary (~100MB). Network once, then
   cached. */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";

/* Generated per run, never written as literals. A fixed string would leak
   nothing from a throwaway database, but a password-shaped literal in a
   committed file is indistinguishable from a real one — to a reader and to a
   secret scanner. Long enough to clear the API's 10-character floor. */
const secret = () => randomBytes(12).toString("base64url");

const ADMIN_PASSWORD = secret();
const HANDLE_PASSWORD = secret();
const EDITOR_PASSWORD = secret();

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "smoke-test-secret-that-is-long-enough-to-pass";
process.env.CORS_ORIGINS = "";

/* ⚠ Raised, not disabled. The limiter still runs on every submission below —
   its store, its key and its headers — but a suite that posts a few dozen
   forms from one address would otherwise spend most of its run being told to
   come back in ten minutes. */
process.env.FORM_WRITE_LIMIT = "1000";
process.env.FORM_ATTEMPT_LIMIT = "5000";
process.env.REGISTER_WRITE_LIMIT = "1000";
process.env.REGISTER_ATTEMPT_LIMIT = "5000";

/* ⚠ EMPTIED, not left to the environment, and not for tidiness: config.js loads
   .env, so a developer with a real RESEND_API_KEY had this suite making LIVE
   Resend calls on every run. They bounced only because the fixtures use
   example.com — a deliverable address would email a real person.

   Assigning "" rather than deleting is what makes it stick: dotenv only fills
   in keys ABSENT from process.env. */
process.env.RESEND_API_KEY = "";
process.env.MAIL_FROM = "";
/* ⚠ And the notification address, for the same reason — a developer with
   MAIL_TO set would have every smoke run emailing a real inbox. */
process.env.MAIL_TO = "";
process.env.CMS_URL = "";

/* ⚠ EMPTIED for the same reason, and it bit exactly the same way: config.js
   loads .env, so a developer with real R2 credentials had this suite PUTting
   a file into the production bucket on every run. Assigning "" rather than
   deleting is what makes it stick — dotenv only fills in absent keys.
   Uploading to R2 is covered by hand against the bucket; what runs here is
   every guard in front of it. */
process.env.R2_ACCOUNT_ID = "";
process.env.R2_ACCESS_KEY_ID = "";
process.env.R2_SECRET_ACCESS_KEY = "";
process.env.R2_BUCKET = "";
process.env.R2_PUBLIC_URL = "";

const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri("iwan_cms_smoke");

const { connectDb, disconnectDb } = await import("../src/db.js");
const { createApp } = await import("../src/app.js");
const { User } = await import("../src/models/User.js");

await connectDb();

const server = await new Promise((resolve) => {
  const s = createApp().listen(0, () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
const checks = [];

const check = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    checks.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
};

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, res };
};

console.log("\nhealth and auth");

await check("GET /health reports a connected database", async () => {
  const { status, body } = await call("GET", "/health");
  assert.equal(status, 200);
  assert.equal(body.db, "connected");
});

await User.create({
  email: "smoke@iwan.community",
  name: "Smoke",
  passwordHash: await User.hashPassword(ADMIN_PASSWORD),
  role: "admin",
});

await check("a wrong password is refused", async () => {
  const { status } = await call("POST", "/api/auth/login", {
    body: { email: "smoke@iwan.community", password: "nope" },
  });
  assert.equal(status, 401);
});

let token = null;

await check("signing in returns a token", async () => {
  const { status, body } = await call("POST", "/api/auth/login", {
    body: { email: "smoke@iwan.community", password: ADMIN_PASSWORD },
  });
  assert.equal(status, 200);
  assert.ok(body.token);
  assert.equal(body.user.role, "admin");
  /* ⚠ The hash must never appear in a response. */
  assert.equal(body.user.passwordHash, undefined);
  token = body.token;
});

await check("an account can sign in with a username instead of an email", async () => {
  await User.create({
    email: "handle@iwan.community",
    username: "smoke-handle",
    name: "Handle",
    passwordHash: await User.hashPassword(HANDLE_PASSWORD),
    role: "admin",
  });

  const byName = await call("POST", "/api/auth/login", {
    body: { email: "smoke-handle", password: HANDLE_PASSWORD },
  });
  assert.equal(byName.status, 200, "username login refused");
  assert.equal(byName.body.user.username, "smoke-handle");

  /* The email still works for the same account — one is not a replacement
     for the other. */
  const byEmail = await call("POST", "/api/auth/login", {
    body: { email: "handle@iwan.community", password: HANDLE_PASSWORD },
  });
  assert.equal(byEmail.status, 200, "email login broke");

  /* And a wrong password is still refused, whichever identifier is used. */
  const bad = await call("POST", "/api/auth/login", {
    body: { email: "smoke-handle", password: "definitely-not-it" },
  });
  assert.equal(bad.status, 401);
});

await check("accounts with no username do not collide", async () => {
  /* ⚠ The sparse index is what allows this. Without it the SECOND account
     leaving username unset would collide with the first on a null value. */
  for (const n of [1, 2]) {
    const { status } = await call("POST", "/api/admin/users", {
      token,
      body: {
        email: `nameless${n}@iwan.community`,
        password: ADMIN_PASSWORD,
        role: "editor",
      },
    });
    assert.equal(status, 201, `account ${n} was refused`);
  }
});

await check("the admin API is closed without a token", async () => {
  const { status } = await call("GET", "/api/admin/events");
  assert.equal(status, 401);
});

/* ⚠ Every PUBLISHED event needs a registration form now. These tests are about
   other things, so they carry the smallest form that satisfies that. */
const MINIMAL_FORM = [
  { key: "full_name", type: "name", label: "Your name", required: true },
  { key: "email", type: "email", label: "E-mail", required: true },
];

console.log("\nevents");

await check("an event with a bad date is rejected field by field", async () => {
  const { status, body } = await call("POST", "/api/admin/events", {
    token,
    body: { slug: "bad-date", title: "Nope", date: "21-08-2026" },
  });
  assert.equal(status, 400);
  assert.ok(body.details.some((d) => d.field === "date"));
});

await check("creating a published Canadian event", async () => {
  const { status, body } = await call("POST", "/api/admin/events", {
    token,
    body: {
      slug: "toronto-meetup",
      title: "Toronto Meetup",
      countries: ["ca"],
      status: "published",
      date: "2026-09-12",
      start: "18:30",
      end: "21:00",
      venue: "Community Hall",
      programme: "/iwan-youth",
      spots: 40,
      summary: "An evening for anyone new to the city.",
      agenda: [{ time: "18:30", label: "Doors open" }],
      form: MINIMAL_FORM,
    },
  });
  assert.equal(status, 201);
  assert.deepEqual(body.countries, ["ca"]);
});

await check("a duplicate slug is a 409, not a 500", async () => {
  const { status } = await call("POST", "/api/admin/events", {
    token,
    body: { slug: "toronto-meetup", title: "Again", date: "2026-09-13" },
  });
  assert.equal(status, 409);
});

await check("a draft event is invisible to the public API", async () => {
  await call("POST", "/api/admin/events", {
    token,
    body: {
      slug: "unannounced",
      title: "Not announced yet",
      countries: ["ca"],
      status: "draft",
      date: "2026-09-20",
    },
  });
  const { body } = await call("GET", "/api/events?country=ca");
  assert.ok(!body.items.some((e) => e.id === "unannounced"));
});

await check("the public event matches the site's content shape", async () => {
  const { status, body } = await call("GET", "/api/events/toronto-meetup?country=ca");
  assert.equal(status, 200);
  /* `id` is the slug — the field name the site's own content files use. */
  assert.equal(body.id, "toronto-meetup");
  assert.equal(body.country, "ca");
  /* The agenda comes back as PAIRS, the way EventDetail renders it. */
  assert.deepEqual(body.agenda, [["18:30", "Doors open"]]);
  /* Absent values are omitted rather than sent as nulls. */
  assert.equal("img" in body, false);
});

await check("an event for Canada does not show for India", async () => {
  const { body } = await call("GET", "/api/events?country=in");
  assert.ok(!body.items.some((e) => e.id === "toronto-meetup"));
});

await check("a global event shows for both countries", async () => {
  await call("POST", "/api/admin/events", {
    token,
    body: {
      slug: "global-open-evening",
      title: "Open Evening",
      countries: [],
      status: "published",
      date: "2026-10-17",
      form: MINIMAL_FORM,
    },
  });
  for (const code of ["in", "ca"]) {
    const { body } = await call("GET", `/api/events?country=${code}`);
    const hit = body.items.find((e) => e.id === "global-open-evening");
    assert.ok(hit, `missing for ${code}`);
    /* No `country` key at all — which is how the site says "everywhere". */
    assert.equal("country" in hit, false);
  }
});

await check("PATCH updates one field and leaves the rest alone", async () => {
  const { body: list } = await call("GET", "/api/admin/events?q=toronto", { token });
  const id = list.items[0].id;
  const { status, body } = await call("PATCH", `/api/admin/events/${id}`, {
    token,
    body: { venue: "The Annex" },
  });
  assert.equal(status, 200);
  assert.equal(body.venue, "The Annex");
  assert.equal(body.title, "Toronto Meetup");
});

await check("admission defaults to free, on the card and the detail", async () => {
  const { body } = await call("GET", "/api/events/toronto-meetup?country=ca");
  assert.equal(body.admission, "free");
  const { body: list } = await call("GET", "/api/events?country=ca");
  const card = list.items.find((e) => e.id === "toronto-meetup");
  assert.equal(card.admission, "free", "the card omitted admission");
});

await check("admission round-trips as ticket", async () => {
  const { body: list } = await call("GET", "/api/admin/events?q=toronto", { token });
  const id = list.items[0].id;
  const { status, body } = await call("PATCH", `/api/admin/events/${id}`, {
    token,
    body: { admission: "ticket" },
  });
  assert.equal(status, 200);
  assert.equal(body.admission, "ticket");
  const { body: pub } = await call("GET", "/api/events/toronto-meetup?country=ca");
  assert.equal(pub.admission, "ticket");
});

await check("an admission the enum does not know is refused", async () => {
  const { body: list } = await call("GET", "/api/admin/events?q=toronto", { token });
  const { status, body } = await call("PATCH", `/api/admin/events/${list.items[0].id}`, {
    token,
    body: { admission: "vip" },
  });
  assert.equal(status, 400);
  assert.ok(body.details.some((d) => d.field === "admission"));
});

await check("⚠ upcoming come first, then past — newest past at the top", async () => {
  /* The listing reaches two months back, and a plain date-ascending sort put
     the OLDEST ended event on page one, which reads as a stale site. */
  const day = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  const seed = [
    ["order-soon", day(3)],
    ["order-later", day(30)],
    ["order-recent-past", day(-5)],
    ["order-older-past", day(-40)],
  ];
  for (const [slug, date] of seed) {
    await call("POST", "/api/admin/events", {
      token,
      body: {
        slug,
        title: slug,
        countries: [],
        status: "published",
        date,
        form: MINIMAL_FORM,
      },
    });
  }

  const { body } = await call(
    "GET",
    `/api/events?from=${day(-60)}&today=${day(0)}&limit=50`
  );
  const seen = body.items.map((e) => e.id).filter((id) => id.startsWith("order-"));
  assert.deepEqual(
    seen,
    ["order-soon", "order-later", "order-recent-past", "order-older-past"],
    "events are not ordered upcoming-soonest then past-newest"
  );
});

await check("the ordering survives paging across the upcoming/past seam", async () => {
  /* The boundary can fall mid-page — the whole reason this is one aggregation
     rather than two stitched queries. */
  const day = (o) => {
    const d = new Date();
    d.setDate(d.getDate() + o);
    return d.toISOString().slice(0, 10);
  };
  const all = [];
  for (const page of [1, 2, 3, 4, 5, 6]) {
    const { body } = await call(
      "GET",
      `/api/events?from=${day(-60)}&today=${day(0)}&limit=1&page=${page}`
    );
    all.push(...body.items.map((e) => e.id));
  }
  const ours = all.filter((id) => id.startsWith("order-"));
  /* Paged one at a time, the sequence must match the single-page one. */
  assert.deepEqual(ours, [
    "order-soon",
    "order-later",
    "order-recent-past",
    "order-older-past",
  ]);
  /* ⚠ And nothing may be served twice or skipped by the aggregation's skip. */
  assert.equal(new Set(all).size, all.length, "a page repeated an event");
});

await check("⚠ the ADMIN events list is newest first, not the site's order", async () => {
  /* Two different questions. The site asks "what is on next"; the desk asks
     "what did I touch last", and date-ascending opened it on the oldest event
     ever run. The fixtures above span both sides of today. */
  const { body } = await call("GET", "/api/admin/events?q=order-&limit=50", { token });
  const seen = body.items.map((e) => e.slug).filter((slug) => slug.startsWith("order-"));
  assert.deepEqual(
    seen,
    ["order-later", "order-soon", "order-recent-past", "order-older-past"],
    "the admin events list is not date-descending"
  );
});

await check("a past event is served when ?from= reaches back for it", async () => {
  /* /events with from = two months back is how the site shows recently-ended
     events in the same list — the $gte filter is the whole mechanism. */
  const monthAgo = new Date();
  monthAgo.setMonth(monthAgo.getMonth() - 1);
  const date = monthAgo.toISOString().slice(0, 10);
  const twoBack = new Date();
  twoBack.setMonth(twoBack.getMonth() - 2);

  await call("POST", "/api/admin/events", {
    token,
    body: {
      slug: "last-month",
      title: "Last month",
      countries: [],
      status: "published",
      date,
      form: MINIMAL_FORM,
    },
  });

  const today = new Date().toISOString().slice(0, 10);
  const reaching = await call(
    "GET",
    `/api/events?from=${twoBack.toISOString().slice(0, 10)}`
  );
  assert.ok(
    reaching.body.items.some((e) => e.id === "last-month"),
    "the ended event is missing from the reached-back list"
  );
  const upcoming = await call("GET", `/api/events?from=${today}`);
  assert.ok(
    !upcoming.body.items.some((e) => e.id === "last-month"),
    "an ended event leaked into the upcoming list"
  );
});

console.log("\nthe registration form");

const findEvent = async (slug) => {
  const { body } = await call("GET", `/api/admin/events?q=${slug}`, { token });
  return body.items.find((e) => e.slug === slug);
};

const FORM = [
  { key: "full_name", type: "name", label: "Your Full Name", required: true },
  {
    key: "licence",
    type: "radio",
    label: "Do you have a Fishing Licence?",
    required: true,
    options: [{ label: "Yes" }, { label: "No" }],
  },
  {
    key: "email",
    type: "email",
    label: "E-mail",
    required: true,
    help: "example@example.com",
  },
  {
    key: "agree",
    type: "consent",
    label: "I agree to follow all safety rules",
    required: true,
  },
  { key: "dietary", type: "textarea", label: "Any dietary restrictions?" },
];

await check("an event saves with a registration form", async () => {
  const { status, body } = await call("POST", "/api/admin/events", {
    token,
    body: {
      slug: "fishing-day",
      title: "Fishing Day",
      countries: ["ca"],
      status: "published",
      date: "2026-11-14",
      form: FORM,
    },
  });
  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(body.form.length, 5);
  assert.equal(body.form[1].options.length, 2);
});

await check("the public event serves the form, ready to render", async () => {
  const { body } = await call("GET", "/api/events/fishing-day?country=ca");
  assert.equal(body.form.length, 5);
  /* Options flatten to plain strings for a renderer — no object bookkeeping. */
  assert.deepEqual(body.form[1].options, ["Yes", "No"]);
  /* `required: false` is omitted rather than sent as false. */
  assert.equal("required" in body.form[4], false);
  assert.equal(body.form[0].required, true);
});

await check("a listing card says a form EXISTS but does not carry it", async () => {
  const { body } = await call("GET", "/api/events?country=ca");
  const card = body.items.find((e) => e.id === "fishing-day");
  assert.ok(card, "event missing from the list");
  assert.equal(card.hasForm, true);
  assert.equal("form" in card, false, "the whole form leaked into the listing");
});

await check("⚠ publishing without a form is refused", async () => {
  const { status, body } = await call("POST", "/api/admin/events", {
    token,
    body: {
      slug: "no-form-event",
      title: "No form",
      countries: [],
      status: "published",
      date: "2026-11-20",
    },
  });
  assert.equal(status, 400);
  assert.ok(
    body.details.some((d) => d.field === "form"),
    JSON.stringify(body)
  );
});

await check("but a DRAFT without a form saves fine", async () => {
  const { status } = await call("POST", "/api/admin/events", {
    token,
    body: {
      slug: "draft-no-form",
      title: "Still writing this",
      countries: [],
      status: "draft",
      date: "2026-11-21",
    },
  });
  assert.equal(status, 201);
});

await check("and that draft cannot then be published while empty", async () => {
  const draft = await findEvent("draft-no-form");
  const { status } = await call("PATCH", `/api/admin/events/${draft.id}`, {
    token,
    body: { status: "published" },
  });
  /* ⚠ The guard has to see the MERGED event — a PATCH carrying only `status`
     says nothing about the form, and checking the patch alone would let this
     straight through. */
  assert.equal(status, 400);
});

await check("two questions cannot share a key", async () => {
  const { status, body } = await call("POST", "/api/admin/events", {
    token,
    body: {
      slug: "dupe-keys",
      title: "Dupe",
      status: "draft",
      date: "2026-11-22",
      form: [
        { key: "email", type: "email", label: "Your email" },
        { key: "email", type: "text", label: "A second email" },
      ],
    },
  });
  assert.equal(status, 400);
  assert.ok(/already used/.test(JSON.stringify(body.details)), JSON.stringify(body));
});

await check("a choice question with no options is refused", async () => {
  const { status, body } = await call("POST", "/api/admin/events", {
    token,
    body: {
      slug: "no-options",
      title: "No options",
      status: "draft",
      date: "2026-11-23",
      form: [{ key: "pick", type: "radio", label: "Pick one", options: [] }],
    },
  });
  assert.equal(status, 400);
  assert.ok(/no options/.test(JSON.stringify(body.details)));
});

await check("duplicate option labels are refused", async () => {
  const { status } = await call("POST", "/api/admin/events", {
    token,
    body: {
      slug: "dupe-options",
      title: "Dupe options",
      status: "draft",
      date: "2026-11-24",
      form: [
        {
          key: "pick",
          type: "radio",
          label: "Pick one",
          options: [{ label: "Yes" }, { label: "yes" }],
        },
      ],
    },
  });
  assert.equal(status, 400);
});

await check("an unknown field type is refused", async () => {
  const { status } = await call("POST", "/api/admin/events", {
    token,
    body: {
      slug: "bad-type",
      title: "Bad type",
      status: "draft",
      date: "2026-11-25",
      form: [{ key: "x", type: "signature", label: "Sign here" }],
    },
  });
  assert.equal(status, 400);
});

/* The admin addresses documents by Mongo id, so a test that PATCHes one has to
   look it up by slug first. */
const findBlog = async (slug) => {
  const { body } = await call("GET", `/api/admin/blogs?q=${slug}`, { token });
  return body.items.find((b) => b.slug === slug);
};

console.log("\nblogs and podcast");

await check("a post is stored and served as HTML", async () => {
  await call("POST", "/api/admin/blogs", {
    token,
    body: {
      slug: "a-post",
      title: "A post",
      status: "published",
      date: "2026-03-01",
      html: "<h2>A heading</h2><p>A <strong>bold</strong> paragraph</p><ul><li>A point</li></ul>",
    },
  });
  const { body } = await call("GET", "/api/blogs/a-post");
  assert.match(body.html, /<h2>A heading<\/h2>/);
  assert.match(body.html, /<strong>bold<\/strong>/);
});

/* ⚠ The whole reason sanitising lives on the write path: what comes back out
   is rendered with dangerouslySetInnerHTML. If any of these survive, that is a
   stored XSS on every visitor to the post. */
await check("script tags and their contents are stripped", async () => {
  await call("POST", "/api/admin/blogs", {
    token,
    body: {
      slug: "nasty",
      title: "Nasty",
      status: "published",
      html: '<p>Fine</p><script>alert(1)</script><p onclick="alert(2)">Also fine</p>',
    },
  });
  const { body } = await call("GET", "/api/blogs/nasty");
  assert.ok(!body.html.includes("<script"), "script tag survived");
  assert.ok(!body.html.includes("alert(1)"), "script CONTENT survived");
  assert.ok(!body.html.includes("onclick"), "event handler survived");
  assert.match(body.html, /<p>Fine<\/p>/);
});

await check("a javascript: link is stripped", async () => {
  await call("PATCH", `/api/admin/blogs/${(await findBlog("nasty")).id}`, {
    token,
    body: { html: '<p><a href="javascript:alert(1)">click</a></p>' },
  });
  const { body } = await call("GET", "/api/blogs/nasty");
  assert.ok(!body.html.includes("javascript:"), "javascript: URL survived");
});

await check("an ordinary link gets rel=noopener and target=_blank", async () => {
  await call("PATCH", `/api/admin/blogs/${(await findBlog("nasty")).id}`, {
    token,
    body: { html: '<p><a href="https://example.com">ok</a></p>' },
  });
  const { body } = await call("GET", "/api/blogs/nasty");
  assert.match(body.html, /rel="noopener noreferrer"/);
  assert.match(body.html, /target="_blank"/);
});

await check("an h1 is dropped — the page supplies its own", async () => {
  await call("PATCH", `/api/admin/blogs/${(await findBlog("nasty")).id}`, {
    token,
    body: { html: "<h1>Second h1</h1><h2>Fine</h2>" },
  });
  const { body } = await call("GET", "/api/blogs/nasty");
  assert.ok(!body.html.includes("<h1"), "h1 survived");
  assert.match(body.html, /<h2>Fine<\/h2>/);
});

await check("the podcast serves the show and its episodes together", async () => {
  await call("PUT", "/api/admin/podcast/show", {
    token,
    body: { title: "iwan.community", description: "A podcast", cover: "" },
  });
  await call("POST", "/api/admin/episodes", {
    token,
    body: {
      slug: "coco",
      title: "CoCo",
      status: "published",
      author: "iwan.community",
      audio: "https://example.com/coco.mp3",
      length: 348,
    },
  });
  const { body } = await call("GET", "/api/podcast?country=in");
  assert.equal(body.title, "iwan.community");
  /* ⚠ `items`, like every other paged route. This used to also repeat the same
     array as `episodes`, shipping it twice. */
  assert.ok(!("episodes" in body), "/api/podcast still carries a duplicate array");
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].id, "coco");
  assert.equal(body.items[0].length, 348);
});

console.log("\nregistrations");

/* `fishing-day` was published above with FORM: name, radio, email, consent,
   textarea. Its slug is what the public endpoint is addressed by. */
const REG = (over = {}) => ({
  full_name: { first: "Aisha", last: "Rahman" },
  licence: "Yes",
  email: "aisha@example.com",
  agree: true,
  dietary: "No nuts",
  ...over,
});

await check("a complete registration is accepted", async () => {
  const { status, body } = await call(
    "POST",
    "/api/events/fishing-day/register?country=ca",
    {
      body: { answers: REG() },
    }
  );
  assert.equal(status, 201, JSON.stringify(body));
  assert.ok(body.id);
  /* ⚠ The public response must not echo the answers back. */
  assert.equal("answers" in body, false);
});

await check("it is readable in the admin with every answer", async () => {
  const { body } = await call("GET", "/api/admin/registrations?event=fishing-day", {
    token,
  });
  assert.equal(body.total, 1);
  const r = body.items[0];
  assert.equal(r.name, "Aisha Rahman");
  assert.equal(r.email, "aisha@example.com");
  assert.equal(r.status, "new");
  assert.equal(r.answers.length, 5);
  /* ⚠ The question is stored WITH the answer, so it stays readable after the
     form is edited. */
  assert.equal(r.answers[1].label, "Do you have a Fishing Licence?");
  assert.equal(r.answers[1].value, "Yes");
  assert.deepEqual(r.answers[0].value, { first: "Aisha", last: "Rahman" });
  assert.equal(r.answers[3].value, true);
});

await check("⚠ editing the form does not rewrite past answers", async () => {
  const ev = await findEvent("fishing-day");
  await call("PATCH", `/api/admin/events/${ev.id}`, {
    token,
    body: {
      form: [
        { key: "full_name", type: "name", label: "RENAMED", required: true },
        { key: "email", type: "email", label: "E-mail", required: true },
      ],
    },
  });
  const { body } = await call("GET", "/api/admin/registrations?event=fishing-day", {
    token,
  });
  const r = body.items[0];
  assert.equal(r.answers[0].label, "Your Full Name", "a past answer was rewritten");
  assert.equal(r.answers.length, 5, "answers to deleted questions vanished");
});

await check("a missing required answer is refused, field by field", async () => {
  const { status, body } = await call(
    "POST",
    "/api/events/fishing-day/register?country=ca",
    {
      body: { answers: { full_name: { first: "", last: "" } } },
    }
  );
  assert.equal(status, 400);
  assert.ok(body.details.some((d) => d.field === "full_name"));
  assert.ok(body.details.some((d) => d.field === "email"));
});

await check("an unticked agreement is refused", async () => {
  const ev = await findEvent("fishing-day");
  await call("PATCH", `/api/admin/events/${ev.id}`, { token, body: { form: FORM } });
  const { status, body } = await call(
    "POST",
    "/api/events/fishing-day/register?country=ca",
    {
      body: { answers: REG({ agree: false }) },
    }
  );
  assert.equal(status, 400);
  assert.ok(body.details.some((d) => d.field === "agree"));
});

await check("⚠ an answer outside the offered choices is refused", async () => {
  const { status, body } = await call(
    "POST",
    "/api/events/fishing-day/register?country=ca",
    {
      body: { answers: REG({ licence: "Maybe, I forget" }) },
    }
  );
  assert.equal(status, 400);
  assert.ok(/not one of the choices/.test(JSON.stringify(body.details)));
});

await check("⚠ a key that is not in the form is dropped, not stored", async () => {
  await call("POST", "/api/events/fishing-day/register?country=ca", {
    body: { answers: REG({ is_admin: true, injected: "hello" }) },
  });
  const { body } = await call("GET", "/api/admin/registrations?event=fishing-day", {
    token,
  });
  const keys = body.items[0].answers.map((a) => a.key);
  assert.ok(!keys.includes("is_admin"), "an invented field was stored");
  assert.ok(!keys.includes("injected"));
});

await check("a bad email is refused", async () => {
  const { status } = await call("POST", "/api/events/fishing-day/register?country=ca", {
    body: { answers: REG({ email: "not-an-email" }) },
  });
  assert.equal(status, 400);
});

await check("a DRAFT event cannot be registered for", async () => {
  const { status } = await call("POST", "/api/events/draft-no-form/register", {
    body: { answers: {} },
  });
  assert.equal(status, 404);
});

await check("an event from another country cannot be registered for", async () => {
  /* fishing-day is Canada-only. */
  const { status } = await call("POST", "/api/events/fishing-day/register?country=in", {
    body: { answers: REG() },
  });
  assert.equal(status, 404);
});

await check("status and notes can be set from the admin", async () => {
  const { body: list } = await call("GET", "/api/admin/registrations?event=fishing-day", {
    token,
  });
  const id = list.items[0].id;
  const { status, body } = await call("PATCH", `/api/admin/registrations/${id}`, {
    token,
    body: { status: "confirmed", note: "Called — bringing two children" },
  });
  assert.equal(status, 200);
  assert.equal(body.status, "confirmed");
  assert.equal(body.note, "Called — bringing two children");
});

await check("the events summary counts sign-ups against capacity", async () => {
  const { body } = await call("GET", "/api/admin/registrations/events", { token });
  const row = body.items.find((e) => e.slug === "fishing-day");
  assert.ok(row, "event missing from the summary");
  assert.ok(row.total >= 2);
  assert.equal(row.title, "Fishing Day");
});

await check("the CSV export has one column per question", async () => {
  const res = await fetch(`${base}/api/admin/registrations/export?event=fishing-day`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  const csv = await res.text();
  const header = csv.split("\r\n")[0];
  assert.match(header, /Your Full Name/);
  assert.match(header, /Do you have a Fishing Licence\?/);
  assert.match(csv, /Aisha Rahman/);
});

await check("⚠ a CSV answer cannot become a spreadsheet formula", async () => {
  await call("POST", "/api/events/fishing-day/register?country=ca", {
    body: { answers: REG({ dietary: '=HYPERLINK("http://evil","click")' }) },
  });
  const res = await fetch(`${base}/api/admin/registrations/export?event=fishing-day`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const csv = await res.text();
  /* Excel treats a leading = as a formula. It must be neutralised. */
  assert.ok(!/,=HYPERLINK/.test(csv), "a formula survived into the CSV");
  assert.match(csv, /'=HYPERLINK/);
});

await check("photo consent rides beside the answers, three states", async () => {
  /* Like `subscribe`: a fixed site-wide field, not one of the event's own
     questions — buildAnswers would drop it as an unknown key. */
  await call("POST", "/api/events/fishing-day/register?country=ca", {
    body: {
      answers: REG({ email: "consenting@example.com" }),
      photoConsent: true,
    },
  });
  await call("POST", "/api/events/fishing-day/register?country=ca", {
    body: {
      answers: REG({ email: "declining@example.com" }),
      photoConsent: false,
    },
  });

  const { body } = await call("GET", "/api/admin/registrations?event=fishing-day", {
    token,
  });
  const byEmail = Object.fromEntries(body.items.map((r) => [r.email, r.photoConsent]));
  assert.equal(byEmail["consenting@example.com"], true);
  assert.equal(byEmail["declining@example.com"], false);
  /* The first registration predates the field being sent — null, never false. */
  assert.equal(byEmail["aisha@example.com"], null);
});

await check("the CSV carries photo consent as its own column", async () => {
  const res = await fetch(`${base}/api/admin/registrations/export?event=fishing-day`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const csv = await res.text();
  const [header, ...rows] = csv.trimEnd().split("\r\n");
  assert.match(header, /Photo consent/);
  /* A Date used to fall into the object branch of cell() and render empty. */
  assert.match(rows[0], /^\d{4}-\d{2}-\d{2}T/, "the Submitted cell is blank");
  const col = header.split(",").indexOf("Photo consent");
  const cellsFor = (email) =>
    rows.find((r) => r.includes(email.split("@")[0]))?.split(",") ?? [];
  assert.equal(cellsFor("declining@example.com")[col], "No");
  assert.equal(cellsFor("consenting@example.com")[col], "Yes");
});

console.log("\nresending a confirmation");

/* ⚠ WHAT THIS RUN CANNOT COVER, stated so the gap is not mistaken for cover.

   Mail is switched off here, so every resend stops at the first guard: the
   successful send and the "no email"/"cancelled" refusals are UNTESTED and need
   exercising by hand against a deployment with mail configured. What IS tested
   is that the route exists, is behind the sign-in, and fails loudly with a
   reason rather than claiming to have sent something. */

await check("resending needs a sign-in", async () => {
  const { body: list } = await call("GET", "/api/admin/registrations?event=fishing-day", {
    token,
  });
  const { status } = await call(
    "POST",
    `/api/admin/registrations/${list.items[0].id}/resend`
  );
  assert.equal(status, 401);
});

await check("resending for an unknown registration is a 404", async () => {
  /* A well-formed ObjectId that belongs to nothing — a malformed one would be
     caught as a cast error instead and prove something different. */
  const { status } = await call(
    "POST",
    "/api/admin/registrations/0123456789abcdef01234567/resend",
    { token }
  );
  assert.equal(status, 404);
});

await check("⚠ with mail switched off, resending SAYS SO rather than lying", async () => {
  const { body: list } = await call("GET", "/api/admin/registrations?event=fishing-day", {
    token,
  });
  const { status, body } = await call(
    "POST",
    `/api/admin/registrations/${list.items[0].id}/resend`,
    { token }
  );
  /* The failure that matters: an editor pressing Resend on a server with no
     mail provider must be told, not shown a success toast. */
  assert.equal(status, 400);
  assert.match(body.error, /not configured/i);
});

await check("a registration reports what is known about its confirmation", async () => {
  const { body } = await call("GET", "/api/admin/registrations?event=fishing-day", {
    token,
  });
  const row = body.items[0];
  /* Serialised for the CMS even when nothing was ever sent — the column has to
     exist for the screen to say "no record" rather than render undefined. */
  assert.ok("confirmationSentAt" in row, "confirmationSentAt is not serialised");
  assert.equal(row.confirmationSentCount, 0);
  /* Nothing was sent, so nothing may claim it was. */
  assert.equal(row.confirmationSentAt, null);
});

console.log("\npodcast episodes");

/* An episode plays as audio or as video; one of the two has to be there. */

await check("⚠ a video url that is not YouTube is refused", async () => {
  const { status, body } = await call("POST", "/api/admin/episodes", {
    token,
    body: {
      slug: "not-youtube",
      title: "Not YouTube",
      countries: [],
      status: "draft",
      video: "https://example.com/ep.mp4",
    },
  });
  assert.equal(status, 400);
  assert.match(JSON.stringify(body.details ?? body), /YouTube/i);
});

await check("an episode with only a VIDEO url is accepted", async () => {
  const { status, body } = await call("POST", "/api/admin/episodes", {
    token,
    body: {
      slug: "video-only",
      title: "Video only",
      countries: [],
      status: "published",
      video: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    },
  });
  assert.equal(status, 201);
  assert.equal(body.video, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(body.audio, "");
});

await check("an episode with only an AUDIO url is accepted", async () => {
  const { status } = await call("POST", "/api/admin/episodes", {
    token,
    body: {
      slug: "audio-only",
      title: "Audio only",
      countries: [],
      status: "published",
      audio: "https://example.com/ep.mp3",
    },
  });
  assert.equal(status, 201);
});

await check("⚠ an episode with BOTH urls is refused", async () => {
  const { status, body } = await call("POST", "/api/admin/episodes", {
    token,
    body: {
      slug: "both-urls",
      title: "Both",
      countries: [],
      status: "draft",
      audio: "https://example.com/ep.mp3",
      video: "https://youtu.be/dQw4w9WgXcQ",
    },
  });
  assert.equal(status, 400);
  assert.match(body.error, /not both/i);
});

await check("⚠ a PATCH cannot add the second url either", async () => {
  const { body: list } = await call("GET", "/api/admin/episodes?q=audio-only", { token });
  const ep = list.items.find((e) => e.slug === "audio-only");
  const { status } = await call("PATCH", `/api/admin/episodes/${ep.id}`, {
    token,
    body: { video: "https://youtu.be/dQw4w9WgXcQ" },
  });
  assert.equal(status, 400);
});

await check("⚠ an episode with NEITHER url is refused", async () => {
  const { status, body } = await call("POST", "/api/admin/episodes", {
    token,
    body: { slug: "silent", title: "Silent", countries: [], status: "draft" },
  });
  assert.equal(status, 400);
  assert.match(body.error, /audio or a video/i);
});

await check("⚠ a PATCH cannot clear the last remaining url", async () => {
  /* Checked on the MERGED document — the patch alone says nothing about the
     field it is not touching. */
  const { body: list } = await call("GET", "/api/admin/episodes?q=audio-only", { token });
  const ep = list.items.find((e) => e.slug === "audio-only");
  const { status } = await call("PATCH", `/api/admin/episodes/${ep.id}`, {
    token,
    body: { audio: "" },
  });
  assert.equal(status, 400);
});

await check("an episode can be filed under a programme", async () => {
  const { body: list } = await call("GET", "/api/admin/episodes?q=video-only", { token });
  const ep = list.items.find((e) => e.slug === "video-only");
  const { status, body } = await call("PATCH", `/api/admin/episodes/${ep.id}`, {
    token,
    body: { programme: "/iwan-youth" },
  });
  assert.equal(status, 200);
  assert.equal(body.programme, "/iwan-youth");

  /* And the filter that crud.js offers to any type carrying the field. */
  const filtered = await call("GET", "/api/admin/episodes?programme=/iwan-youth", {
    token,
  });
  assert.ok(filtered.body.items.some((e) => e.slug === "video-only"));
});

await check("the site is served both urls", async () => {
  const { body } = await call("GET", "/api/podcast");
  const ep = body.items.find((e) => e.id === "video-only");
  assert.ok(ep, "video-only episode missing from the public payload");
  assert.equal(ep.video, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(ep.programme, "/iwan-youth");
});

await check("the public podcast list takes the programme filter", async () => {
  /* Same server-side filter events and blogs already honour — page one of
     "youth episodes" is not page one of everything. */
  const youth = await call("GET", "/api/podcast?programme=/iwan-youth");
  assert.ok(youth.body.items.some((e) => e.id === "video-only"));
  assert.ok(
    youth.body.items.every((e) => e.programme === "/iwan-youth"),
    "an episode from another programme got through"
  );
  assert.equal(youth.body.total, youth.body.items.length);

  const community = await call("GET", "/api/podcast?programme=__none");
  assert.ok(community.body.items.some((e) => e.id === "coco"));
  assert.ok(
    community.body.items.every((e) => !e.programme),
    "a programme episode matched __none"
  );

  const all = await call("GET", "/api/podcast");
  assert.ok(all.body.total >= youth.body.total + community.body.total);
});

console.log("\nthe programme filter");

await check("filtering by programme narrows the admin list", async () => {
  const { body } = await call("GET", "/api/admin/events?programme=/iwan-youth", {
    token,
  });
  assert.ok(body.items.length >= 1, "found nothing");
  assert.ok(
    body.items.every((e) => e.programme === "/iwan-youth"),
    "returned an event from another programme"
  );
  /* The count has to be the count of MATCHES, since the admin prints it. */
  assert.equal(body.total, body.items.length);
});

await check('"__none" finds the ones open to all, not everything', async () => {
  const { body } = await call("GET", "/api/admin/events?programme=__none", { token });
  assert.ok(body.items.length >= 1, "found nothing");
  assert.ok(
    body.items.every((e) => !e.programme),
    "returned an event that has a programme"
  );
});

await check("a type with no programme field ignores the filter", async () => {
  /* Promos have no `programme`. The filter must be dropped rather than applied
     to a field that does not exist — which would match nothing and look like
     the promos had vanished. */
  const all = await call("GET", "/api/admin/promos", { token });
  const filtered = await call("GET", "/api/admin/promos?programme=/iwan-youth", {
    token,
  });
  assert.equal(filtered.body.total, all.body.total);
});

console.log("\ndetail nav and related");

await check("a blog detail carries its neighbours and related posts", async () => {
  /* Three dated posts on top of the earlier fixtures. Blogs list newest-first,
     so rel-a is the head of the list. */
  for (const [slug, date, programme] of [
    ["rel-a", "2026-05-03", "/iwan-youth"],
    ["rel-b", "2026-05-02", "/iwan-youth"],
    ["rel-c", "2026-05-01", null],
  ]) {
    await call("POST", "/api/admin/blogs", {
      token,
      body: { slug, title: slug, status: "published", date, programme, html: "<p>x</p>" },
    });
  }

  const { body } = await call("GET", "/api/blogs/rel-b");
  /* Display order: prev is the newer neighbour, next the older. */
  assert.equal(body.nav.prev.id, "rel-a");
  assert.equal(body.nav.next.id, "rel-c");
  /* Same programme first, then the list's own order pads to three. */
  assert.equal(body.related.length, 3);
  assert.equal(body.related[0].id, "rel-a");
  assert.ok(!body.related.some((b) => b.id === "rel-b"), "related includes itself");
  /* Cards, not details — html must not ride along. */
  assert.equal("html" in body.related[0], false);
  assert.equal("html" in body.nav.prev, false);
});

await check("the newest post has no prev — stated, not omitted", async () => {
  const { body } = await call("GET", "/api/blogs/rel-a");
  assert.equal(body.nav.prev, null);
  assert.equal(body.nav.next.id, "rel-b");
});

await check("an episode detail carries number, neighbours and related", async () => {
  /* Episodes list by running order then creation: coco, video-only, audio-only. */
  const { body } = await call("GET", "/api/podcast/video-only");
  assert.equal(body.number, 2);
  assert.equal(body.nav.prev.id, "coco");
  assert.equal(body.nav.next.id, "audio-only");
  assert.ok(!body.related.some((e) => e.id === "video-only"), "related includes itself");
  assert.ok(body.related.length >= 2);
});

await check("⚠ the ADMIN episode list reverses the site's running order", async () => {
  /* The site numbers episodes by `order` ascending — episode 01 first, and
     that is what `order` is for. The desk wants the latest one at the top. */
  const { body } = await call("GET", "/api/admin/episodes?limit=50", { token });
  const ours = body.items
    .map((e) => e.slug)
    .filter((slug) => ["coco", "video-only", "audio-only"].includes(slug));
  assert.deepEqual(ours, ["audio-only", "video-only", "coco"]);
});

console.log("\npromos");

await check("no eligible promo serves null, not an error", async () => {
  const { status, body } = await call("GET", "/api/promo?country=in");
  assert.equal(status, 200);
  assert.equal(body, null);
});

await check("a country promo beats a global one", async () => {
  /* ⚠ Written STRAIGHT TO THE DATABASE, because the admin routes now refuse to
     publish two promos whose windows and audiences overlap — which this pair
     does by construction. The precedence rule is still the resolver's, and
     still has to hold for documents written before that guard existed. */
  const { Promo } = await import("../src/models/Promo.js");
  await Promo.create([
    {
      slug: "global-promo",
      status: "published",
      countries: [],
      heading: "Everywhere",
      mark: "promo",
      cta: { label: "Go", to: "/events" },
    },
    {
      slug: "ca-promo",
      status: "published",
      countries: ["ca"],
      heading: "Canada",
      mark: "promo",
      cta: { label: "Go", to: "/events" },
    },
  ]);

  const { body: ca } = await call("GET", "/api/promo?country=ca");
  assert.equal(ca.id, "ca-promo");

  const { body: india } = await call("GET", "/api/promo?country=in");
  assert.equal(india.id, "global-promo");
});

await check("a promo outside its window is not served", async () => {
  /* Direct for the same reason: a 2020 promo overlaps the open-ended global
     one above under the new rule, and this is about the READ side. */
  const { Promo } = await import("../src/models/Promo.js");
  await Promo.create({
    slug: "expired-promo",
    status: "published",
    countries: ["in"],
    heading: "Last",
    mark: "year",
    priority: 99,
    startsAt: "2020-01-01",
    endsAt: "2020-12-31",
    cta: { label: "Go", to: "/" },
  });
  const { body } = await call("GET", "/api/promo?country=in");
  assert.equal(body.id, "global-promo");
});

await check("a backwards promo window is refused", async () => {
  const { status } = await call("POST", "/api/admin/promos", {
    token,
    body: {
      slug: "backwards",
      heading: "x",
      startsAt: "2026-12-01",
      endsAt: "2026-01-01",
    },
  });
  assert.equal(status, 400);
});

console.log("\none published promo at a time");

/* ⚠ The fixtures above are still in the database and published, so every promo
   written here is scoped to a country nothing else uses. */
const promoBody = (slug, extra = {}) => ({
  slug,
  name: slug,
  countries: ["in"],
  heading: "x",
  cta: { label: "Go", to: "/" },
  ...extra,
});

await check("⚠ a second published promo over the same dates is refused", async () => {
  const { Promo } = await import("../src/models/Promo.js");
  await Promo.deleteMany({});

  const first = await call("POST", "/api/admin/promos", {
    token,
    body: promoBody("promo-june", {
      name: "June campaign",
      status: "published",
      startsAt: "2027-06-10",
      endsAt: "2027-06-20",
    }),
  });
  assert.equal(first.status, 201);

  /* Starts inside the first one's window. */
  const { status, body } = await call("POST", "/api/admin/promos", {
    token,
    body: promoBody("promo-clash", {
      status: "published",
      startsAt: "2027-06-15",
      endsAt: "2027-06-25",
    }),
  });
  assert.equal(status, 400);
  assert.ok(
    body.error.includes("June campaign"),
    `the message does not name the promo in the way: ${body.error}`
  );
  /* ⚠ No field details — the admin shows a generic toast for those, and this
     message is the whole point of the refusal. */
  assert.equal("details" in body, false);
});

await check("the same dates are fine as a DRAFT", async () => {
  const { status } = await call("POST", "/api/admin/promos", {
    token,
    body: promoBody("promo-draft", {
      status: "draft",
      /* ⚠ Inside June's window but clear of "promo-after" below, so the last
         check in this block tests the thing it says it does. */
      startsAt: "2027-06-15",
      endsAt: "2027-06-18",
    }),
  });
  assert.equal(status, 201);
});

await check("a window that starts the day after is fine", async () => {
  const { status } = await call("POST", "/api/admin/promos", {
    token,
    body: promoBody("promo-after", {
      status: "published",
      startsAt: "2027-06-21",
      endsAt: "2027-06-30",
    }),
  });
  assert.equal(status, 201);
});

await check("⚠ the last day of one window still collides", async () => {
  const { status } = await call("POST", "/api/admin/promos", {
    token,
    body: promoBody("promo-edge", {
      status: "published",
      startsAt: "2027-06-20",
      endsAt: "2027-06-22",
    }),
  });
  assert.equal(status, 400, "the window is inclusive at both ends");
});

await check("another COUNTRY over the same dates is fine", async () => {
  const { status } = await call("POST", "/api/admin/promos", {
    token,
    body: promoBody("promo-ca", {
      countries: ["ca"],
      status: "published",
      startsAt: "2027-06-15",
      endsAt: "2027-06-25",
    }),
  });
  assert.equal(status, 201);
});

await check("⚠ a global promo collides with a country one", async () => {
  /* Empty countries means everywhere, so the same visitor would be eligible
     for both — which is the thing being prevented, not a country pairing. */
  const { status, body } = await call("POST", "/api/admin/promos", {
    token,
    body: promoBody("promo-global", {
      countries: [],
      status: "published",
      startsAt: "2027-06-15",
      endsAt: "2027-06-25",
    }),
  });
  assert.equal(status, 400);
  assert.ok(body.error.includes("June campaign"));
});

await check("a promo with NO window collides with everything published", async () => {
  const { status } = await call("POST", "/api/admin/promos", {
    token,
    body: promoBody("promo-forever", { status: "published" }),
  });
  assert.equal(status, 400, "an open-ended promo runs on every date");
});

await check("⚠ a promo does not collide with ITSELF on save", async () => {
  const { body: list } = await call("GET", "/api/admin/promos?q=promo-june", { token });
  const id = list.items[0].id;

  const patched = await call("PATCH", `/api/admin/promos/${id}`, {
    token,
    body: { heading: "Renamed" },
  });
  assert.equal(patched.status, 200, "editing the live promo was refused");

  /* ⚠ PUT carries no id in its body, so self-exclusion has to come from the
     route — this is the case that catches it going through the body. */
  const put = await call("PUT", `/api/admin/promos/${id}`, {
    token,
    body: promoBody("promo-june", {
      name: "June campaign",
      status: "published",
      startsAt: "2027-06-10",
      endsAt: "2027-06-20",
    }),
  });
  assert.equal(put.status, 200, "replacing the live promo was refused");
});

await check("publishing a DRAFT into a taken window is refused", async () => {
  const { body: list } = await call("GET", "/api/admin/promos?q=promo-draft", { token });
  const { status } = await call("PATCH", `/api/admin/promos/${list.items[0].id}`, {
    token,
    body: { status: "published" },
  });
  assert.equal(status, 400, "the check ran on the merged document, or should have");
});

await check("the window is free again once the live promo is unpublished", async () => {
  const { body: list } = await call("GET", "/api/admin/promos?q=promo-june", { token });
  const off = await call("PATCH", `/api/admin/promos/${list.items[0].id}`, {
    token,
    body: { status: "draft" },
  });
  assert.equal(off.status, 200);

  const { body: drafts } = await call("GET", "/api/admin/promos?q=promo-draft", {
    token,
  });
  const { status } = await call("PATCH", `/api/admin/promos/${drafts.items[0].id}`, {
    token,
    body: { status: "published" },
  });
  assert.equal(status, 200);
});

/* ⚠ Back to ONE live promo, for Canada — the bootstrap check further down
   reads the promo Canada is served. The block above is cleared first: its
   fixtures are published in 2027, and an open-ended promo overlaps every date
   there is, which is the rule this whole section just established. */
await (await import("../src/models/Promo.js")).Promo.deleteMany({});
await call("POST", "/api/admin/promos", {
  token,
  body: {
    slug: "ca-promo",
    name: "Canada",
    countries: ["ca"],
    status: "published",
    heading: "Canada",
    mark: "promo",
    cta: { label: "Go", to: "/events" },
  },
});

console.log("\ncountry scoping");

await check("a scoped editor cannot write outside their countries", async () => {
  await call("POST", "/api/admin/users", {
    token,
    body: {
      email: "india@iwan.community",
      password: EDITOR_PASSWORD,
      role: "editor",
      countries: ["in"],
    },
  });
  const { body: session } = await call("POST", "/api/auth/login", {
    body: { email: "india@iwan.community", password: EDITOR_PASSWORD },
  });

  const denied = await call("POST", "/api/admin/events", {
    token: session.token,
    body: {
      slug: "sneaky",
      title: "Not yours",
      countries: ["ca"],
      date: "2026-11-01",
    },
  });
  assert.equal(denied.status, 403);

  /* Nor can they publish to everywhere, which would include Canada. */
  const global = await call("POST", "/api/admin/events", {
    token: session.token,
    body: { slug: "sneaky-2", title: "Everywhere", countries: [], date: "2026-11-01" },
  });
  assert.equal(global.status, 403);

  const allowed = await call("POST", "/api/admin/events", {
    token: session.token,
    body: {
      slug: "bangalore-circle",
      title: "Allowed",
      countries: ["in"],
      date: "2026-11-01",
    },
  });
  assert.equal(allowed.status, 201);
});

await check("an editor cannot create accounts", async () => {
  const { body: session } = await call("POST", "/api/auth/login", {
    body: { email: "india@iwan.community", password: EDITOR_PASSWORD },
  });
  const { status } = await call("POST", "/api/admin/users", {
    token: session.token,
    body: { email: "x@y.com", password: secret() },
  });
  assert.equal(status, 403);
});

await check("the last admin cannot be demoted", async () => {
  const { body: users } = await call("GET", "/api/admin/users", { token });
  const me = users.items.find((u) => u.email === "smoke@iwan.community");
  const { status } = await call("PATCH", `/api/admin/users/${me.id}`, {
    token,
    body: { role: "editor" },
  });
  assert.equal(status, 400);
});

console.log("\nwhat a scoped account can SEE");

/* A global document appears on every country's site, so a scoped account has
   to see it in the CMS too — otherwise the CMS disagrees with the site. */

const SCOPE_PASSWORD = secret();
let bothToken = null;
let indiaToken = null;

await check("a global blog exists to be found", async () => {
  const { status } = await call("POST", "/api/admin/blogs", {
    token,
    body: {
      slug: "everywhere-post",
      title: "Everywhere post",
      countries: [],
      status: "published",
      html: "<p>Shown in every country.</p>",
    },
  });
  assert.equal(status, 201);
});

await check("accounts scoped to one country and to both can sign in", async () => {
  for (const [email, countries] of [
    ["both@iwan.community", ["in", "ca"]],
    ["india-only@iwan.community", ["in"]],
  ]) {
    const made = await call("POST", "/api/admin/users", {
      token,
      body: { email, password: SCOPE_PASSWORD, role: "editor", countries },
    });
    assert.equal(made.status, 201, `could not create ${email}`);
  }
  const both = await call("POST", "/api/auth/login", {
    body: { email: "both@iwan.community", password: SCOPE_PASSWORD },
  });
  bothToken = both.body.token;
  const india = await call("POST", "/api/auth/login", {
    body: { email: "india-only@iwan.community", password: SCOPE_PASSWORD },
  });
  indiaToken = india.body.token;
  assert.ok(bothToken && indiaToken);
});

await check("⚠ an editor holding BOTH countries sees a global item", async () => {
  const { body } = await call("GET", "/api/admin/blogs", { token: bothToken });
  const slugs = body.items.map((b) => b.slug);
  assert.ok(
    slugs.includes("everywhere-post"),
    `an account holding every country could not see a global post: ${slugs.join(", ")}`
  );
});

await check("⚠ an editor scoped to ONE country sees a global item too", async () => {
  const { body } = await call("GET", "/api/admin/blogs", { token: indiaToken });
  const slugs = body.items.map((b) => b.slug);
  assert.ok(
    slugs.includes("everywhere-post"),
    "a global post was hidden from a scoped editor"
  );
});

await check("a scoped account still cannot see ANOTHER country's item", async () => {
  const made = await call("POST", "/api/admin/blogs", {
    token,
    body: { slug: "canada-only-post", title: "Canada only", countries: ["ca"] },
  });
  assert.equal(made.status, 201);
  const { body } = await call("GET", "/api/admin/blogs", { token: indiaToken });
  const slugs = body.items.map((b) => b.slug);
  assert.ok(
    !slugs.includes("canada-only-post"),
    "an India editor saw a Canada-only post"
  );
});

await check("⚠ seeing a global item is not being able to change it", async () => {
  /* Visibility widened; the write rule did not move. */
  const { body } = await call("GET", "/api/admin/blogs", { token: indiaToken });
  const post = body.items.find((b) => b.slug === "everywhere-post");
  assert.ok(post, "nothing to try to edit");
  const { status } = await call("PATCH", `/api/admin/blogs/${post.id}`, {
    token: indiaToken,
    body: { title: "Rewritten by a scoped editor" },
  });
  assert.equal(status, 403);
});

await check("⚠ a scoped account cannot read another country's item BY ID", async () => {
  /* The scope belongs to the account, not to one route. */
  const { body: all } = await call("GET", "/api/admin/blogs", { token });
  const canada = all.items.find((b) => b.slug === "canada-only-post");
  assert.ok(canada, "fixture missing");

  const mine = await call("GET", `/api/admin/blogs/${canada.id}`, { token: indiaToken });
  assert.equal(mine.status, 404);

  /* An admin still reads it, so this is a scope and not a broken route. */
  const asAdmin = await call("GET", `/api/admin/blogs/${canada.id}`, { token });
  assert.equal(asAdmin.status, 200);
});

await check("⚠ searching cannot widen what a scoped account sees", async () => {
  /* Two top-level `$or`s would replace each other; both live under `$and`. */
  const { body } = await call("GET", "/api/admin/blogs?q=Canada", { token: indiaToken });
  const slugs = body.items.map((b) => b.slug);
  assert.ok(
    !slugs.includes("canada-only-post"),
    `search leaked an out-of-scope row: ${slugs.join(", ")}`
  );
});

console.log("\nroles");

/* A viewer is defined by what it cannot do, so these are mostly refusals —
   one per route family, since the guard is mounted router-wide. */

const VIEWER_PASSWORD = secret();
let viewerToken = null;

await check("an admin can create a viewer", async () => {
  const { status, body } = await call("POST", "/api/admin/users", {
    token,
    body: {
      email: "viewer@iwan.community",
      name: "Viewer",
      password: VIEWER_PASSWORD,
      role: "viewer",
    },
  });
  assert.equal(status, 201);
  assert.equal(body.role, "viewer");
});

await check("a viewer can sign in", async () => {
  const { status, body } = await call("POST", "/api/auth/login", {
    body: { email: "viewer@iwan.community", password: VIEWER_PASSWORD },
  });
  assert.equal(status, 200);
  viewerToken = body.token;
  assert.equal(body.user.role, "viewer");
});

await check("a viewer CAN read content", async () => {
  const { status, body } = await call("GET", "/api/admin/events", { token: viewerToken });
  assert.equal(status, 200);
  assert.ok(body.items.length >= 1, "a viewer saw no events");
});

await check("a viewer CAN read registrations and export them", async () => {
  const list = await call("GET", "/api/admin/registrations", { token: viewerToken });
  assert.equal(list.status, 200);
  const res = await fetch(`${base}/api/admin/registrations/export`, {
    headers: { authorization: `Bearer ${viewerToken}` },
  });
  assert.equal(res.status, 200);
});

await check("⚠ a viewer cannot CREATE content", async () => {
  const { status } = await call("POST", "/api/admin/blogs", {
    token: viewerToken,
    body: { slug: "viewer-post", title: "Nope", countries: [], status: "draft" },
  });
  assert.equal(status, 403);
});

await check("⚠ a viewer cannot EDIT content", async () => {
  const { body: list } = await call("GET", "/api/admin/events", { token: viewerToken });
  const { status } = await call("PATCH", `/api/admin/events/${list.items[0].id}`, {
    token: viewerToken,
    body: { title: "Renamed by a viewer" },
  });
  assert.equal(status, 403);
});

await check("⚠ a viewer cannot DELETE content", async () => {
  const { body: list } = await call("GET", "/api/admin/blogs", { token: viewerToken });
  const { status } = await call("DELETE", `/api/admin/blogs/${list.items[0].id}`, {
    token: viewerToken,
  });
  assert.equal(status, 403);
});

await check("⚠ a viewer cannot change a registration or resend its email", async () => {
  const { body: list } = await call("GET", "/api/admin/registrations", {
    token: viewerToken,
  });
  const id = list.items[0].id;
  const patched = await call("PATCH", `/api/admin/registrations/${id}`, {
    token: viewerToken,
    body: { status: "confirmed" },
  });
  assert.equal(patched.status, 403);
  /* A POST, and refused for the same reason — it puts mail in an inbox. */
  const resent = await call("POST", `/api/admin/registrations/${id}/resend`, {
    token: viewerToken,
  });
  assert.equal(resent.status, 403);
});

await check("⚠ a viewer cannot write the podcast show", async () => {
  const { status } = await call("PUT", "/api/admin/podcast/show", {
    token: viewerToken,
    body: { title: "Nope", description: "", cover: "" },
  });
  assert.equal(status, 403);
});

await check("⚠ a viewer cannot reach accounts at all", async () => {
  const read = await call("GET", "/api/admin/users", { token: viewerToken });
  assert.equal(read.status, 403);
  const write = await call("POST", "/api/admin/users", {
    token: viewerToken,
    body: { email: "x@y.com", name: "X", password: secret(), role: "admin" },
  });
  assert.equal(write.status, 403);
});

await check("a viewer CAN still change its own password", async () => {
  /* ⚠ Under /api/auth, so the write guard does not reach it — and must not. */
  const { status } = await call("POST", "/api/auth/change-password", {
    token: viewerToken,
    body: { currentPassword: VIEWER_PASSWORD, newPassword: secret() },
  });
  assert.equal(status, 200);
});

await check("⚠ an admin cannot demote ITSELF to viewer", async () => {
  /* Proved above for `editor`; repeated for `viewer` because a third role is
     what turns a two-value rule into a wrong one. */
  const { body } = await call("GET", "/api/admin/users", { token });
  const me = body.items.find((u) => u.email === "smoke@iwan.community");
  const { status, body: err } = await call("PATCH", `/api/admin/users/${me.id}`, {
    token,
    body: { role: "viewer" },
  });
  assert.equal(status, 400);
  assert.match(err.error, /own admin role/i);
});

console.log("\napplication forms");

/* A list of forms per kind, one live at a time. The site renders the live one
   verbatim — there is no static copy underneath it to fall back to. */

const NAME_FIELD = { key: "name", type: "name", label: "Your name", required: true };
const EMAIL_FIELD = { key: "email", type: "email", label: "Your email", required: true };
const MOBILE_FIELD = { key: "mobile", type: "phone", label: "Mobile", required: true };

let volunteerFormId = null;
let secondFormId = null;

await check("an editor can create a form, and it is NOT live yet", async () => {
  const { status, body } = await call("POST", "/api/admin/apply-forms", {
    token,
    body: {
      kind: "volunteer",
      name: "Volunteer form",
      countries: [],
      eyebrow: "Volunteer",
      heading: "Give some time to",
      mark: "Iwan",
      intro: "Our programmes run on people who turn up.",
      formHeading: "Tell us about you",
      submitLabel: "Send my details",
      subscribeLabel: "Keep me posted",
      doneHeading: "Thank you",
      doneBody: "We have your details.",
      fields: [
        NAME_FIELD,
        EMAIL_FIELD,
        MOBILE_FIELD,
        { key: "role", type: "text", label: "What would you like to help with" },
        { key: "availability", type: "text", label: "When you are free" },
        { key: "about", type: "textarea", label: "A little about you", required: true },
      ],
    },
  });
  assert.equal(status, 201);
  assert.equal(body.active, false, "a new form went live on its own");
  volunteerFormId = body.id;
});

await check(
  "⚠ with nothing live, the page says so and submissions are refused",
  async () => {
    const page = await call("GET", "/api/apply-forms/volunteer?country=in");
    assert.equal(page.body.active, false);
    assert.ok(!page.body.fields, "a form was invented for a page with none live");

    const posted = await call("POST", "/api/volunteer", {
      body: { answers: { email: "early@example.com" } },
    });
    assert.equal(posted.status, 400);
  }
);

await check("activating one makes it live", async () => {
  const { status } = await call(
    "POST",
    `/api/admin/apply-forms/${volunteerFormId}/activate`,
    {
      token,
    }
  );
  assert.equal(status, 200);

  const { body } = await call("GET", "/api/apply-forms/volunteer?country=in");
  assert.equal(body.heading, "Give some time to");
  assert.ok(body.fields.some((f) => f.key === "availability"));
});

await check("⚠ the site is served the CMS copy VERBATIM", async () => {
  /* The whole point of "what the CMS has is what the page shows" — every word
     comes from the record, with nothing merged in underneath. */
  const { body } = await call("GET", "/api/apply-forms/volunteer?country=in");
  assert.equal(body.eyebrow, "Volunteer");
  assert.equal(body.mark, "Iwan");
  assert.equal(body.submitLabel, "Send my details");
  assert.equal(body.doneBody, "We have your details.");
});

await check("⚠ activating a second form turns the first OFF", async () => {
  const made = await call("POST", "/api/admin/apply-forms", {
    token,
    body: {
      kind: "volunteer",
      name: "Volunteer form v2",
      countries: [],
      heading: "Second form",
      fields: [EMAIL_FIELD, { key: "why", type: "textarea", label: "Why volunteer" }],
    },
  });
  secondFormId = made.body.id;

  const { body } = await call("POST", `/api/admin/apply-forms/${secondFormId}/activate`, {
    token,
  });
  assert.equal(body.displaced, 1, "the first form was left live alongside the second");

  const list = await call("GET", "/api/admin/apply-forms?kind=volunteer", { token });
  const live = list.body.items.filter((f) => f.active);
  assert.equal(live.length, 1, `${live.length} forms are live at once`);
  assert.equal(live[0].id, secondFormId);
});

await check("a country form beats the global one", async () => {
  const made = await call("POST", "/api/admin/apply-forms", {
    token,
    body: {
      kind: "volunteer",
      name: "Volunteer form — Canada",
      countries: ["ca"],
      heading: "Volunteer in",
      mark: "Canada",
      fields: [EMAIL_FIELD, { key: "city", type: "text", label: "Which city" }],
    },
  });
  await call("POST", `/api/admin/apply-forms/${made.body.id}/activate`, { token });

  const ca = await call("GET", "/api/apply-forms/volunteer?country=ca");
  assert.equal(ca.body.heading, "Volunteer in");

  /* ⚠ And the global one is still live for everywhere else — a Canada-only
     form does not displace it. */
  const inn = await call("GET", "/api/apply-forms/volunteer?country=in");
  assert.equal(inn.body.heading, "Second form");
});

await check("⚠ a form with no questions cannot go live", async () => {
  const made = await call("POST", "/api/admin/apply-forms", {
    token,
    body: { kind: "career", name: "Empty", countries: [], fields: [] },
  });
  assert.equal(made.status, 201, "an empty form should still be saveable as a draft");

  const { status, body } = await call(
    "POST",
    `/api/admin/apply-forms/${made.body.id}/activate`,
    { token }
  );
  assert.equal(status, 400);
  assert.match(body.error, /no questions/i);
});

await check("⚠ a form with questions but no EMAIL is refused", async () => {
  const { status, body } = await call("POST", "/api/admin/apply-forms", {
    token,
    body: {
      kind: "career",
      name: "No email",
      countries: [],
      fields: [{ key: "name", type: "text", label: "Your name" }],
    },
  });
  assert.equal(status, 400);
  assert.match(body.error, /email/i);
});

await check("⚠ a LIVE form cannot be deleted", async () => {
  const { status } = await call("DELETE", `/api/admin/apply-forms/${secondFormId}`, {
    token,
  });
  assert.equal(status, 400);

  /* Turning it off first is the deliberate second step. */
  await call("POST", `/api/admin/apply-forms/${secondFormId}/deactivate`, { token });
  const again = await call("DELETE", `/api/admin/apply-forms/${secondFormId}`, { token });
  assert.equal(again.status, 204);
});

await check("the first form can be put back", async () => {
  const { status } = await call(
    "POST",
    `/api/admin/apply-forms/${volunteerFormId}/activate`,
    {
      token,
    }
  );
  assert.equal(status, 200);
  const { body } = await call("GET", "/api/apply-forms/volunteer?country=in");
  assert.equal(body.heading, "Give some time to");
});

await check("a career form is live too", async () => {
  const made = await call("POST", "/api/admin/apply-forms", {
    token,
    body: {
      kind: "career",
      name: "Career form",
      countries: [],
      heading: "Build something with",
      mark: "Iwan",
      doneHeading: "Thank you",
      fields: [
        NAME_FIELD,
        EMAIL_FIELD,
        MOBILE_FIELD,
        { key: "role", type: "text", label: "Role", required: true },
        { key: "experience", type: "text", label: "Years of experience" },
        { key: "portfolio", type: "text", label: "Portfolio" },
        {
          key: "about",
          type: "textarea",
          label: "About your experience",
          required: true,
        },
      ],
    },
  });
  const { status } = await call(
    "POST",
    `/api/admin/apply-forms/${made.body.id}/activate`,
    {
      token,
    }
  );
  assert.equal(status, 200);
});

await check("⚠ the API creates its default forms on boot, and only once", async () => {
  /* server.js calls this after connecting. The suite boots the app directly, so
     it calls the same function — the point is that it is idempotent and never
     displaces a live form. */
  const { ensureDefaultApplyForms } = await import("../src/lib/applyForms.js");
  const { ApplyForm } = await import("../src/models/ApplyForm.js");

  const first = await ensureDefaultApplyForms();
  assert.deepEqual(first.sort(), ["career", "volunteer"]);

  /* ⚠ A volunteer form is already live from the checks above, so the default
     must arrive switched OFF rather than taking the page over. */
  const volunteerDefault = await ApplyForm.findOne({
    kind: "volunteer",
    isDefault: true,
  }).lean();
  assert.equal(volunteerDefault.active, false, "the default displaced a live form");

  /* Career had nothing live, so its default is on. */
  const careerDefault = await ApplyForm.findOne({
    kind: "career",
    isDefault: true,
  }).lean();
  assert.ok(careerDefault, "no career default was created");

  /* Running it again changes nothing. */
  const second = await ensureDefaultApplyForms();
  assert.deepEqual(second, [], "a restart created a second default");
  assert.equal(await ApplyForm.countDocuments({ isDefault: true }), 2);
});

await check("⚠ the DEFAULT form cannot be deleted, only turned off", async () => {
  /* Seeded rather than created here, so the suite makes one the same way the
     seed does — through the model, since the API deliberately offers no way to
     mint a default. */
  const { ApplyForm } = await import("../src/models/ApplyForm.js");
  const made = await ApplyForm.create({
    kind: "career",
    name: "Default career form",
    countries: [],
    isDefault: true,
    heading: "Build something that",
    mark: "lasts.",
    fields: [EMAIL_FIELD],
  });

  const { body: listed } = await call("GET", "/api/admin/apply-forms?kind=career", {
    token,
  });
  assert.equal(
    listed.items.find((f) => f.id === String(made._id)).isDefault,
    true,
    "the default flag is not serialised"
  );

  const deleted = await call("DELETE", `/api/admin/apply-forms/${made._id}`, { token });
  assert.equal(deleted.status, 400);
  assert.match(deleted.body.error, /default/i);

  /* Turning it off is allowed — that is a deliberate "not taking applications". */
  const off = await call("POST", `/api/admin/apply-forms/${made._id}/deactivate`, {
    token,
  });
  assert.equal(off.status, 200);
  assert.equal(off.body.active, false);

  /* And it still cannot be deleted once off. */
  const again = await call("DELETE", `/api/admin/apply-forms/${made._id}`, { token });
  assert.equal(again.status, 400);
});

await check("⚠ a request cannot make itself the default", async () => {
  const { body } = await call("POST", "/api/admin/apply-forms", {
    token,
    body: {
      kind: "career",
      name: "Pretender",
      countries: [],
      isDefault: true,
      fields: [EMAIL_FIELD],
    },
  });
  assert.equal(body.isDefault, false, "a form promoted itself to default");
});

await check("a viewer cannot create or activate a form", async () => {
  const made = await call("POST", "/api/admin/apply-forms", {
    token: viewerToken,
    body: { kind: "career", name: "Nope", countries: [], fields: [EMAIL_FIELD] },
  });
  assert.equal(made.status, 403);

  const activated = await call(
    "POST",
    `/api/admin/apply-forms/${volunteerFormId}/activate`,
    { token: viewerToken }
  );
  assert.equal(activated.status, 403);
});

console.log("\nuploads");

/* ⚠ R2 is NOT configured in this run (the env block at the top sets no R2_*
   keys), so what is exercised here is everything up to the network call: the
   sign-in, the writer guard, the size cap and the type checks. The PUT itself
   and the resize are covered by hand against the real bucket — a smoke suite
   that uploaded to production storage on every run would fill it with rubbish. */

/* A one-pixel PNG, small enough to inline. */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const postFile = async (
  buffer,
  { name = "photo.png", type = "image/png", token: t } = {}
) => {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type }), name);
  const res = await fetch(`${base}/api/admin/uploads`, {
    method: "POST",
    headers: t ? { authorization: `Bearer ${t}` } : {},
    body: form,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

await check("uploading needs a sign-in", async () => {
  const { status } = await postFile(PNG_1PX);
  assert.equal(status, 401);
});

await check("⚠ a viewer cannot upload", async () => {
  /* The writer guard is keyed on the METHOD, so a POST is refused for a
     read-only account without this route restating anything. */
  const { status } = await postFile(PNG_1PX, { token: viewerToken });
  assert.equal(status, 403);
});

await check("a request with no file is a 400, not a 500", async () => {
  const res = await fetch(`${base}/api/admin/uploads`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: new FormData(),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /no image/i);
});

await check("a file that is not an image is refused by type", async () => {
  const { status, body } = await postFile(Buffer.from("%PDF-1.4 not an image"), {
    name: "notes.pdf",
    type: "application/pdf",
    token,
  });
  assert.equal(status, 400, JSON.stringify(body));
});

await check("⚠ an oversized image is a 400 with a readable reason", async () => {
  /* Multer reports LIMIT_FILE_SIZE through an error-first callback rather than
     a rejected promise, so without the hand-rolled handler this was a 500. */
  const huge = Buffer.alloc(11 * 1024 * 1024, 1);
  const { status, body } = await postFile(huge, { token });
  assert.equal(status, 400);
  assert.match(JSON.stringify(body), /too large|MB/i);
});

await check("with R2 unset, uploading says so rather than half-working", async () => {
  const { status, body } = await postFile(PNG_1PX, { token });
  assert.equal(status, 400);
  assert.match(body.error, /not configured/i);
});

console.log("\nnotifications");

/* ⚠ Mail is OFF in this run (see the env block at the top), so what is proved
   here is the thing that actually matters: a notification that cannot be sent
   NEVER affects the submission. The rendering and a real send are covered by
   hand against Resend. */

await check("a registration still succeeds with notifications off", async () => {
  const { status } = await call("POST", "/api/events/fishing-day/register?country=ca", {
    body: { answers: REG({ email: "notify-off@example.com" }) },
  });
  assert.equal(status, 201);
});

await check("contact still succeeds with notifications off", async () => {
  const { status } = await call("POST", "/api/contact", {
    body: {
      email: "quiet@example.com",
      name: "Quiet Person",
      subject: "Does this still work",
      message: "It should.",
    },
  });
  assert.equal(status, 201);
});

await check("subscribing still succeeds with notifications off", async () => {
  const { status } = await call("POST", "/api/subscribe", {
    body: { email: "quiet-sub@example.com" },
  });
  assert.equal(status, 201);
});

await check("the notification renders every answer, escaped", async () => {
  /* Rendering is pure, so it is tested directly — no network, no mail. */
  const { renderNotification } = await import("../src/lib/emails/notification.js");
  const { subject, html, text } = renderNotification({
    subject: "New registration: Fishing Day",
    heading: "Someone registered",
    rows: [
      ["Name", { first: "Aisha", last: "Rahman" }],
      ["Diet", ["No nuts", "Halal"]],
      ["Newsletter", true],
      ["Photos", false],
      ["Empty", ""],
      ["Nasty", "<script>alert(1)</script>"],
    ],
  });
  assert.equal(subject, "New registration: Fishing Day");
  /* Each value type flattens the way the CSV does. */
  assert.match(html, /Aisha Rahman/);
  assert.match(html, /No nuts, Halal/);
  assert.match(html, /Yes/);
  assert.match(html, /No/);
  /* ⚠ A blank value drops its ROW rather than printing an empty one. */
  assert.ok(!html.includes("Empty"), "an empty row was rendered");
  /* ⚠ Everything here came from a public form. */
  assert.ok(!html.includes("<script>"), "a script tag survived into the email");
  assert.match(html, /&lt;script&gt;/);
  /* Some clients render text only, and no text/plain scores worse for spam. */
  assert.match(text, /Name: Aisha Rahman/);
});

console.log("\naddress search");

/* ⚠ These do NOT reach Photon. The suite must not depend on a third party
   being up, or a network blip fails a run that found nothing wrong — and
   hammering a free service on every run is not a fair use of it. What is
   covered here is the route: the sign-in, the short-query rule and the shape.
   The provider itself is exercised by hand against real queries. */

await check("address search needs a sign-in", async () => {
  const { status } = await call("GET", "/api/admin/places?q=cubbon+park");
  assert.equal(status, 401);
});

await check("a half-typed query is an empty list, not a 400", async () => {
  /* A search box is half-typed most of the time — treating that as a caller
     error would put a red banner under every second keystroke. */
  const { status, body } = await call("GET", "/api/admin/places?q=ab", { token });
  assert.equal(status, 200);
  assert.deepEqual(body.items, []);
  assert.equal(body.query, "ab");
});

await check("an empty query is an empty list", async () => {
  const { status, body } = await call("GET", "/api/admin/places", { token });
  assert.equal(status, 200);
  assert.deepEqual(body.items, []);
});

await check("⚠ a viewer CAN search — it is a read", async () => {
  /* requireWriter guards on the method, and this is a GET. A read-only
     account can look an address up; it just cannot save the event. */
  const { status } = await call("GET", "/api/admin/places?q=ab", { token: viewerToken });
  assert.equal(status, 200);
});

console.log("\nthe audience");

/* Every public form funnels into one row per person, keyed on the email. The
   merge rule is the part worth proving: a later form fills blanks and never
   overwrites, so a hurried name cannot degrade a good one. */

const PERSON = "newcomer@example.com";

await check("⚠ an event sign-up reaches the audience by itself", async () => {
  /* Nobody subscribed here — registering for an event is enough to be a
     contactable person, which is the whole point of one list. */
  const { body } = await call("GET", "/api/admin/audience?q=aisha@example.com", {
    token,
  });
  assert.equal(body.total, 1, "the registration fixture never reached the audience");
  assert.ok(body.items[0].sources.includes("event"));
  assert.equal(body.items[0].name, "Aisha Rahman", "the name did not come across");
});

await check("?source=contact narrows the audience to contact people", async () => {
  /* What the CMS's Contact menu lists — people with the contact source,
     nobody else. The event fixture above must not appear. */
  const { body } = await call("GET", "/api/admin/audience?source=contact", { token });
  assert.ok(body.items.every((r) => r.sources.includes("contact")));
  assert.ok(!body.items.some((r) => r.email === "aisha@example.com"));
});

await check("⚠ an event sign-up carries its own subscribe flag", async () => {
  /* The site adds the checkbox to every event, so it travels beside the answers
     rather than inside them — buildAnswers would drop a key the form does not
     define. */
  await call("POST", "/api/events/fishing-day/register?country=ca", {
    body: {
      answers: REG({ email: "optin@example.com" }),
      subscribe: true,
    },
  });
  const { body } = await call("GET", "/api/admin/audience?q=optin@example.com", {
    token,
  });
  assert.equal(body.total, 1);
  assert.equal(body.items[0].subscribed, true, "the flag beside the answers was ignored");
});

await check("subscribing creates the row", async () => {
  const { status } = await call("POST", "/api/subscribe", {
    body: { email: PERSON },
  });
  assert.equal(status, 201);

  const { body } = await call("GET", `/api/admin/audience?q=${PERSON}`, { token });
  assert.equal(body.total, 1);
  assert.equal(body.items[0].subscribed, true);
  assert.deepEqual(body.items[0].sources, ["subscribe"]);
  assert.equal(body.items[0].name, "");
});

await check("contacting FILLS the blanks and adds a source", async () => {
  const { status } = await call("POST", "/api/contact", {
    body: {
      email: PERSON,
      name: "Aisha Rahman",
      subject: "About the fishing trip",
      mobile: "+91 90000 00000",
      message: "Is there parking?",
    },
  });
  assert.equal(status, 201);

  const { body } = await call("GET", `/api/admin/audience?q=${PERSON}`, { token });
  assert.equal(body.total, 1, "a second row was created for the same email");
  const row = body.items[0];
  assert.equal(row.name, "Aisha Rahman");
  assert.equal(row.mobile, "+91 90000 00000");
  assert.deepEqual(row.sources.sort(), ["contact", "subscribe"]);
  assert.equal(row.messages.length, 1);
  assert.equal(row.messages[0].subject, "About the fishing trip");
});

await check("⚠ a later form NEVER overwrites a stored name", async () => {
  await call("POST", "/api/contact", {
    body: { email: PERSON, name: "aisha", subject: "again", mobile: "+91 1" },
  });

  const { body } = await call("GET", `/api/admin/audience?q=${PERSON}`, { token });
  const row = body.items[0];
  assert.equal(row.name, "Aisha Rahman", "a hurried name replaced a good one");
  assert.equal(row.mobile, "+91 90000 00000", "a hurried number replaced a good one");
  assert.equal(row.messages.length, 2, "the second message was not kept");
});

await check("⚠ an unticked box does not UNSUBSCRIBE someone", async () => {
  await call("POST", "/api/contact", {
    body: { email: PERSON, name: "x", subject: "x", subscribe: false },
  });
  const { body } = await call("GET", `/api/admin/audience?q=${PERSON}`, { token });
  assert.equal(body.items[0].subscribed, true);
});

await check("the CMS can unsubscribe someone deliberately", async () => {
  const { body: list } = await call("GET", `/api/admin/audience?q=${PERSON}`, { token });
  const { status, body } = await call(
    "PATCH",
    `/api/admin/audience/${list.items[0].id}`,
    {
      token,
      body: { subscribed: false },
    }
  );
  assert.equal(status, 200);
  assert.equal(body.subscribed, false);

  /* And subscribing again turns it back on. */
  await call("POST", "/api/subscribe", { body: { email: PERSON } });
  const { body: after } = await call("GET", `/api/admin/audience?q=${PERSON}`, { token });
  assert.equal(after.items[0].subscribed, true);
});

await check(
  "a volunteer application writes BOTH the person and the application",
  async () => {
    /* ⚠ The same shape an event registration posts, keyed by the LIVE form's
       own keys — and Canada has its own live form, so these are its questions
       rather than the global one's. */
    const { status } = await call("POST", "/api/volunteer?country=ca", {
      body: {
        answers: { email: "vol@example.com", city: "Toronto" },
        subscribe: true,
      },
    });
    assert.equal(status, 201, "the volunteer form refused a valid submission");

    const audience = await call("GET", "/api/admin/audience?q=vol@example.com", {
      token,
    });
    assert.equal(audience.body.total, 1);
    assert.deepEqual(audience.body.items[0].sources, ["volunteer"]);

    const apps = await call("GET", "/api/admin/applications?kind=volunteer", { token });
    const app = apps.body.items.find((a) => a.email === "vol@example.com");
    assert.ok(app, "the application was not stored");
    assert.equal(app.country, "ca");
    /* ⚠ By KEY, not label — the labels are CMS content and an editor may
       reword them, which is exactly what a test must not break on. */
    const keys = app.answers.map((a) => a.key);
    assert.ok(keys.includes("city"), `answers were not snapshotted: ${keys}`);
    assert.ok(
      !keys.includes("experience"),
      "a volunteer carried a question only the career form asks"
    );
  }
);

await check("a career application is filed under its own kind", async () => {
  const { status } = await call("POST", "/api/career", {
    body: {
      answers: {
        name: { first: "Dev", last: "Person" },
        email: "dev@example.com",
        mobile: "+91 2",
        role: "Frontend developer",
        about: "Six years of React.",
        portfolio: "https://example.com/me",
      },
    },
  });
  assert.equal(status, 201, "the career form refused a valid submission");

  const { body } = await call("GET", "/api/admin/applications?kind=career", { token });
  const app = body.items.find((a) => a.email === "dev@example.com");
  assert.ok(app);
  assert.equal(app.role, "Frontend developer");

  /* Experience was not filled in, and is still on the row as an empty answer —
     which is what lets the CMS table tell it from a question never asked. */
  const experience = app.answers.find((a) => a.key === "experience");
  assert.ok(experience, "a blank answer was dropped instead of recorded");
  /* buildAnswers stores null for a text field nobody filled in; the CMS renders
     null, undefined and "" identically as a dash. What matters is that the
     question is on the row at all. */
  assert.ok(
    experience.value === null || experience.value === "",
    `expected an empty answer, got ${JSON.stringify(experience.value)}`
  );

  /* ⚠ The kind filter has to actually narrow, or the second CMS tab is the
     first one wearing a different heading. */
  const volunteers = await call("GET", "/api/admin/applications?kind=volunteer", {
    token,
  });
  assert.ok(!volunteers.body.items.some((a) => a.email === "dev@example.com"));
});

await check("⚠ a career application with NO email is refused", async () => {
  const { status } = await call("POST", "/api/career", {
    body: { name: "No Email", mobile: "+91 3", role: "x", about: "x" },
  });
  assert.equal(status, 400);
});

await check("the audience exports as a spreadsheet", async () => {
  const res = await fetch(`${base}/api/admin/audience/export`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const csv = await res.text();
  assert.match(csv, /aisha@example\.com/);
  assert.match(csv.split("\r\n")[0], /subscribed/i);
});

await check("stats count people per form", async () => {
  const { body } = await call("GET", "/api/admin/audience/stats", { token });
  assert.ok(body.total >= 3, `expected at least 3 people, got ${body.total}`);
  assert.ok(body.sources.subscribe >= 1);
  assert.ok(body.sources.volunteer >= 1);
});

await check("⚠ a viewer cannot write the audience", async () => {
  const { body: list } = await call("GET", "/api/admin/audience", { token: viewerToken });
  assert.equal(list.total >= 1, true, "a viewer could not READ the audience");
  const { status } = await call("PATCH", `/api/admin/audience/${list.items[0].id}`, {
    token: viewerToken,
    body: { note: "nope" },
  });
  assert.equal(status, 403);
});

console.log("\nthe one call the site makes");

await check("/api/content is a bounded bootstrap, not the whole database", async () => {
  const { status, body } = await call("GET", "/api/content?country=ca");
  assert.equal(status, 200);
  assert.equal(body.country, "ca");

  for (const key of ["events", "blogs", "podcast", "promo"]) {
    assert.ok(key in body, `missing ${key}`);
  }

  /* Lists arrive paged — `items` plus the `total` a pager needs. */
  for (const key of ["events", "blogs"]) {
    assert.ok(Array.isArray(body[key].items), `${key}.items is not a list`);
    assert.equal(typeof body[key].total, "number", `${key}.total missing`);
    assert.ok(body[key].items.length <= 6, `${key} returned more than one page`);
  }
  assert.ok(Array.isArray(body.podcast.episodes));
  assert.equal(body.promo.id, "ca-promo");

  /* ⚠ The point of the whole split: no detail fields in a list. A post's
     `html` was 81% of the old payload, and an event's `details` and `agenda`
     are only ever read by their own page. */
  for (const post of body.blogs.items) {
    assert.equal("html" in post, false, `${post.id} carries html in the list`);
  }
  for (const event of body.events.items) {
    assert.equal("details" in event, false, `${event.id} carries details`);
    assert.equal("agenda" in event, false, `${event.id} carries an agenda`);
  }
});

await check("a list pages, and the detail route carries the heavy fields", async () => {
  const first = await call("GET", "/api/blogs?limit=1&page=1");
  assert.equal(first.body.items.length, 1);
  assert.ok(first.body.total > 1, "not enough posts to page");

  const second = await call("GET", "/api/blogs?limit=1&page=2");
  assert.equal(second.body.page, 2);
  assert.notEqual(second.body.items[0].id, first.body.items[0].id);

  /* Same record through the detail route: now it has its body. */
  const detail = await call("GET", `/api/blogs/${first.body.items[0].id}`);
  assert.ok(detail.body.html, "the detail route returned no html");
});

await check("?from= filters upcoming events by the visitor's day", async () => {
  await call("POST", "/api/admin/events", {
    token,
    body: {
      slug: "long-past",
      title: "Long past",
      countries: [],
      status: "published",
      date: "2020-01-01",
      form: MINIMAL_FORM,
    },
  });

  const all = await call("GET", "/api/events?country=in");
  assert.ok(
    all.body.items.some((e) => e.id === "long-past"),
    "no filter should show it"
  );

  const upcoming = await call("GET", "/api/events?country=in&from=2026-01-01");
  assert.ok(
    !upcoming.body.items.some((e) => e.id === "long-past"),
    "a past event survived the ?from= filter"
  );
});

await check("an unknown country falls back rather than erroring", async () => {
  const { status, body } = await call("GET", "/api/content?country=zz");
  assert.equal(status, 200);
  assert.equal(body.country, "in");
});

await check("a bad ObjectId is a 400, not a 500", async () => {
  const { status } = await call("GET", "/api/admin/events/not-an-id", { token });
  assert.equal(status, 400);
});

server.close();
await disconnectDb();
await mongod.stop();

console.log(`\n${passed} passed, ${checks.length} failed\n`);
process.exit(checks.length ? 1 : 0);
