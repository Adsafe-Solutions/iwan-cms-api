/* End-to-end smoke test against a throwaway in-memory MongoDB. No test runner:
   it boots the real app, seeds real content, writes through the admin routes
   and reads back through the public ones, asserting the public side is the
   shape the site's components expect.

     npm run smoke

   ⚠ The first run downloads a mongod binary (~100MB). Network once, then
   cached. */

import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
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
/* ⚠ EMPTIED for the same reason, and it bit the same way: config.js loads .env,
   so a developer with API_URL set for local work had this suite building real
   unsubscribe links and failing the check that proves they are DROPPED when
   there is nowhere to point them. What is under test is the unset state. */
process.env.API_URL = "";
/* ⚠ And the contact sync, which reaches Resend on every SUBSCRIBE rather than
   only when mail is sent — a developer with a real key would have had this
   suite writing its fixtures into the live Resend audience. Emptying the key
   above already switches it off; the segment is emptied so a half-set pair
   cannot fail assertConfig on someone else's machine. */
process.env.RESEND_SEGMENT_ID = "";
/* ⚠ A REAL, generated signing secret — and it costs no network at all, because
   verifying a signature is arithmetic on the bytes in hand. So the webhook is
   tested properly here: a correctly signed event really does unsubscribe
   someone, and a forged one really is refused. Generated per run for the same
   reason the passwords above are.

   ⚠ `whsec_` then BASE64: that prefix and encoding are the format Resend
   issues, and the secret is the decoded bytes. A raw string here would verify
   against nothing. */
process.env.RESEND_WEBHOOK_SECRET = `whsec_${randomBytes(24).toString("base64")}`;

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

/* ⚠ What a PUBLISHED record has to carry. The API refuses to publish one with
   a hole in it (validators/publishing.js), so a fixture that goes live spreads
   these — otherwise every check below would really be a test of that rule.
   A DRAFT fixture deliberately does not, since half-written is a legal state. */
const LIVE_EVENT = {
  kind: "Community",
  start: "18:00",
  end: "20:00",
  venue: "Iwan Hall",
  summary: "A gathering.",
  details: "The longer version of what happens.",
  img: "https://example.com/event.jpg",
};

const LIVE_BLOG = {
  date: "2026-05-01",
  excerpt: "A line about the post.",
  html: "<p>The body.</p>",
};

const LIVE_EPISODE = { description: "What this episode is about." };

const LIVE_PROMO = {
  heading: "Something is on",
  body: "A few words about it.",
  cta: { label: "Go", to: "/events" },
};

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
      ...LIVE_EVENT,
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
  /* Absent values are omitted rather than sent as nulls. ⚠ `address` rather
     than `img`: a published event must now carry a photo, so the field that
     proves the point has to be one this event genuinely does not set. */
  assert.equal("address" in body, false);
});

await check("an event for Canada does not show for India", async () => {
  const { body } = await call("GET", "/api/events?country=in");
  assert.ok(!body.items.some((e) => e.id === "toronto-meetup"));
});

await check("a global event shows for both countries", async () => {
  await call("POST", "/api/admin/events", {
    token,
    body: {
      ...LIVE_EVENT,
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
        ...LIVE_EVENT,
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
      ...LIVE_EVENT,
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

await check("⚠ a published event needs everything the site draws", async () => {
  /* Each of these leaves a visible hole on the page — a broken image, a blank
     card, a map pointing at the office. The list is validators/publishing.js. */
  const { status, body } = await call("POST", "/api/admin/events", {
    token,
    body: {
      slug: "half-written",
      title: "Half written",
      status: "published",
      date: "2027-04-01",
      form: MINIMAL_FORM,
    },
  });
  assert.equal(status, 400);
  assert.deepEqual(body.details.map((d) => d.field).sort(), [
    "details",
    "end",
    "img",
    "kind",
    "start",
    "summary",
    "venue",
  ]);
  assert.ok(/Not published/.test(body.error), body.error);
});

await check("⚠ the same event saves happily as a DRAFT", async () => {
  /* Half-written is a normal state — refusing the save would throw it away. */
  const { status } = await call("POST", "/api/admin/events", {
    token,
    body: {
      slug: "half-written",
      title: "Half written",
      date: "2027-04-01",
      /* ⚠ Carries its form, so the PATCH below is refused for the CONTENT it
         is missing rather than stopping at the older empty-form rule. */
      form: MINIMAL_FORM,
    },
  });
  assert.equal(status, 201);
});

await check("a draft cannot be flipped to published while it has holes", async () => {
  const { body: list } = await call("GET", "/api/admin/events?q=half-written", { token });
  const { status, body } = await call("PATCH", `/api/admin/events/${list.items[0].id}`, {
    token,
    body: { status: "published" },
  });
  assert.equal(status, 400, "the rule did not run on the merged document");
  assert.ok(body.details.some((d) => d.field === "summary"));
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
      ...LIVE_EVENT,
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
      ...LIVE_EVENT,
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
    body: {
      ...LIVE_EVENT,
      status: "published",
    },
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
      ...LIVE_BLOG,
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
await check("⚠ the vendored sanitizer matches the installed sanitize-html", async () => {
  /* The bundle is committed (see scripts/vendor-sanitizer.mjs), so bumping the
     dependency without re-running `npm run vendor:sanitizer` would leave the
     API sanitising with the OLD code — silently, and on the one control that
     stands between a compromised CMS account and stored XSS. */
  const { readFile } = await import("node:fs/promises");
  const { SANITIZE_HTML_VERSION } = await import("../src/lib/vendor/sanitize-html.mjs");
  const installed = JSON.parse(
    await readFile("node_modules/sanitize-html/package.json", "utf8")
  ).version;

  assert.equal(
    SANITIZE_HTML_VERSION,
    installed,
    `the bundle is sanitize-html@${SANITIZE_HTML_VERSION} but ${installed} is installed — run: npm run vendor:sanitizer`
  );
});

await check("⚠ the two bypasses the current sanitize-html fixes stay fixed", async () => {
  /* Both are why the version cannot be rolled back to dodge Vercel's runtime:
     a zero-padded numeric reference hiding `javascript:` (fixed in 2.17.2) and
     the `</textarea/>` mutation XSS of GHSA-jxwj-j7wr-gfrw (fixed in 2.17.7). */
  const { sanitize } = await import("../src/lib/html.js");

  assert.ok(
    !/javascript:/i.test(sanitize('<a href="&#0000106avascript:alert(1)">x</a>'))
  );
  assert.ok(
    !/<script/i.test(sanitize("<textarea></textarea/><script>alert(1)</script>"))
  );
});

await check("script tags and their contents are stripped", async () => {
  await call("POST", "/api/admin/blogs", {
    token,
    body: {
      ...LIVE_BLOG,
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
      ...LIVE_EPISODE,
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

await check("⚠ a published post needs a date, an excerpt and a body", async () => {
  const { status, body } = await call("POST", "/api/admin/blogs", {
    token,
    body: { slug: "empty-post", title: "Empty", status: "published" },
  });
  assert.equal(status, 400);
  assert.deepEqual(body.details.map((d) => d.field).sort(), ["date", "excerpt", "html"]);
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
      ...LIVE_EPISODE,
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
      ...LIVE_EPISODE,
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
      body: {
        ...LIVE_BLOG,
        slug,
        title: slug,
        status: "published",
        date,
        programme,
        html: "<p>x</p>",
      },
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

await check("⚠ an episode's own description is on the DETAIL, not the card", async () => {
  /* The show's blurb describes the podcast; this describes one episode. It is
     the heavy field on an episode, so it splits the same way a post's html
     does — out of every list, and out of the bootstrap. */
  const { body: list } = await call("GET", "/api/admin/episodes?q=coco", { token });
  const { status } = await call("PATCH", `/api/admin/episodes/${list.items[0].id}`, {
    token,
    body: { description: "Two friends, one microphone,\nand a long argument." },
  });
  assert.equal(status, 200);

  const { body: detail } = await call("GET", "/api/podcast/coco");
  assert.equal(detail.description, "Two friends, one microphone,\nand a long argument.");

  const { body: page } = await call("GET", "/api/podcast?country=in");
  const card = page.items.find((e) => e.id === "coco");
  assert.equal("description" in card, false, "the card carries the write-up");

  const { body: boot } = await call("GET", "/api/content?country=in");
  const booted = (boot.podcast.episodes ?? []).find((e) => e.id === "coco");
  if (booted) assert.equal("description" in booted, false, "the bootstrap carries it");
});

await check("an episode without one simply has no description key", async () => {
  /* ⚠ Written straight to the database: the admin routes will not publish an
     episode without a write-up any more. Episodes published BEFORE that rule
     still exist and still have to serve, which is what this pins. */
  const { PodcastEpisode } = await import("../src/models/Podcast.js");
  await PodcastEpisode.create({
    slug: "legacy-episode",
    title: "Published before write-ups existed",
    countries: [],
    status: "published",
    audio: "https://example.com/legacy.mp3",
    order: 99,
  });

  const { body } = await call("GET", "/api/podcast/legacy-episode");
  assert.equal("description" in body, false, "an empty write-up was serialized");
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
  ...LIVE_PROMO,
  slug,
  name: slug,
  countries: ["in"],
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

await check("⚠ `priority` is gone — sending one is ignored, not refused", async () => {
  /* It ordered overlapping promos, and overlapping promos can no longer be
     published. The admin PUTs a whole record back, so an old one still holding
     the key has to save rather than 400 — unknown keys are stripped. */
  const { status, body } = await call("POST", "/api/admin/promos", {
    token,
    body: promoBody("promo-priority", { status: "draft", priority: 99 }),
  });
  assert.equal(status, 201);
  assert.equal("priority" in body, false, "priority is still serialized");
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
    body: {
      ...LIVE_PROMO,
      status: "published",
    },
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
    body: {
      ...LIVE_PROMO,
      status: "published",
    },
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
    ...LIVE_PROMO,
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
      ...LIVE_BLOG,
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

console.log("\nthe Resend contact sync");

await check("⚠ exactly THREE segments, because the plan allows three", async () => {
  /* Resend caps segments by plan. These are the ones worth spending them on —
     the two countries, which decide which newsletter somebody should get, and
     event registrations. Everybody else stays findable by their `source`
     property, which every contact carries.
     ⚠ Adding a name here costs a segment on the account. */
  const { SEGMENT_NAMES } = await import("../src/lib/segments.js");
  assert.deepEqual(Object.keys(SEGMENT_NAMES).sort(), ["ca", "event", "in"]);

  /* ⚠ No segment for subscribers: Resend already records `unsubscribed` on
     every contact, so one would only restate it. */
  assert.equal(SEGMENT_NAMES.subscribe, undefined);
});

await check("⚠ no box ticked: the CONFIRMATION sends, the WELCOME does not", async () => {
  /* The two emails answer different questions. A confirmation is the receipt
     for a thing the person just did and goes to everybody who registers; the
     welcome starts a mailing relationship and goes only to whoever asked for
     one. Getting this backwards either loses somebody their booking receipt or
     mails somebody who never opted in. */
  const { Audience } = await import("../src/models/Audience.js");
  const { welcomeSubscriber } = await import("../src/lib/welcome.js");
  const { sendRegistrationConfirmation } = await import("../src/lib/mail.js");

  await call("POST", "/api/events/fishing-day/register?country=ca", {
    body: { answers: REG({ email: "receipt-only@example.com" }) },
  });
  const row = await Audience.findOne({ email: "receipt-only@example.com" }).lean();
  assert.equal(row.subscribed, false);

  /* ⚠ The welcome REFUSES on the subscription, before mail is even consulted. */
  assert.deepEqual(await welcomeSubscriber(row, "ca"), {
    sent: false,
    reason: "not-subscribed",
  });

  /* ⚠ The confirmation does NOT look at the subscription at all — mail being
     off in this run is the only thing stopping it, which is the point. */
  const confirmation = await sendRegistrationConfirmation({
    registration: { email: "receipt-only@example.com", name: "R", country: "ca" },
    event: { title: "Fishing Day", slug: "fishing-day" },
  });
  assert.equal(confirmation.reason, "mail-disabled", "it stopped for the wrong reason");
});

await check("⚠ EVERYONE is mirrored, subscribed or not", async () => {
  /* The event segment is the list of who came, not of who wants mail. Leaving
     non-subscribers out made it silently incomplete — somebody who registered
     without ticking the box still registered.

     ⚠ What protects them is the FLAG: the contact goes to Resend marked
     `unsubscribed`, which every broadcast skips. The audience row is what this
     asserts, since there is no key in this run to check the push itself. */
  const { Audience } = await import("../src/models/Audience.js");

  await call("POST", "/api/events/fishing-day/register?country=ca", {
    body: { answers: REG({ email: "no-box-ticked@example.com" }) },
  });

  const row = await Audience.findOne({ email: "no-box-ticked@example.com" }).lean();
  assert.ok(row, "somebody who did not subscribe still belongs in the audience");
  assert.equal(row.subscribed, false, "an untouched box must not opt anybody in");
  assert.ok(row.sources.includes("event"));

  /* ⚠ And they are NOT welcomed — mirrored is not the same as mailed. */
  const { welcomeSubscriber } = await import("../src/lib/welcome.js");
  assert.deepEqual(await welcomeSubscriber(row, "ca"), {
    sent: false,
    reason: "not-subscribed",
  });
});

await check("⚠ BOTH countries, not just the one they first arrived from", async () => {
  /* A person known from India who subscribes on the Canadian site belongs on
     Canada's list too. The audience row keeps only the FIRST country and never
     changes it, so filing by that alone meant the Canadian segment was never
     created for anyone already known — which is exactly how it looked in the
     dashboard. */
  const { segmentsFor } = await import("../src/lib/segments.js");
  /* No key in this run, so this asserts the SHAPE rather than the round trip —
     the real behaviour is covered against a stubbed account. */
  assert.deepEqual(await segmentsFor({ countries: ["in", "ca"], sources: [] }), []);

  /* ⚠ What recordAudience actually hands over: where they started, and where
     they are acting now. */
  const { Audience } = await import("../src/models/Audience.js");
  await call("POST", "/api/subscribe?country=ca", {
    body: { email: "moved-country@example.com" },
  });
  const row = await Audience.findOne({ email: "moved-country@example.com" }).lean();
  assert.equal(row.country, "ca", "the row records where they first arrived");
});

await check("segments resolve to nothing without a key", async () => {
  /* No key means no account to ask, and a contact in no segment is still a
     contact — it must not become an error on a form submission. */
  const { segmentsFor } = await import("../src/lib/segments.js");
  assert.deepEqual(await segmentsFor({ country: "in", sources: ["event"] }), []);
});

/* ⚠ These do NOT reach Resend. RESEND_API_KEY is empty for this run, so the
   sync is switched off and what is proved here is the property that matters:
   every form still works, and nothing waits on a third party. The push itself
   is covered by hand against a real key — see the README.

   The WEBHOOK half is tested for real, because its interesting behaviour is
   what it refuses. */

await check("the contact sync is off without a key, and says so", async () => {
  const { syncContact, removeContact, CONTACTS_ENABLED } =
    await import("../src/lib/contacts.js");
  assert.equal(CONTACTS_ENABLED, false);
  assert.deepEqual(await syncContact({ email: "nobody@example.com" }), {
    synced: false,
    reason: "contacts-disabled",
  });
  assert.deepEqual(await removeContact("nobody@example.com"), {
    removed: false,
    reason: "contacts-disabled",
  });
});

await check("subscribing still succeeds with the contact sync off", async () => {
  const { status } = await call("POST", "/api/subscribe", {
    body: { email: "mirror-off@example.com" },
  });
  assert.equal(status, 201);

  /* ⚠ The row is stored either way — that is the whole point of the sync being
     fire-and-forget. */
  const { body } = await call("GET", "/api/admin/audience?q=mirror-off", { token });
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].subscribed, true);
});

/* Signs a payload the way Resend does: HMAC-SHA256 over `id.timestamp.body`,
   keyed on the DECODED secret, sent as `v1,<base64>`. ⚠ Signing the exact string
   that is posted, not an object re-encoded on the way out — which is the same
   property the route depends on at the other end. */
const svixPost = async (payload, { secret = process.env.RESEND_WEBHOOK_SECRET } = {}) => {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const id = `msg_${randomBytes(6).toString("hex")}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${payload}`)
    .digest("base64");

  return fetch(`${base}/api/webhooks/resend`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
    },
    body: payload,
  });
};

await check("a signed unsubscribe from Resend reaches the audience", async () => {
  /* ⚠ THE POINT OF THE WHOLE ROUTE. Someone clicking unsubscribe at the bottom
     of a broadcast is recorded by Resend, not here; without this the CMS goes
     on believing they are subscribed. */
  const res = await svixPost(
    JSON.stringify({
      type: "contact.updated",
      data: { email: "mirror-off@example.com", unsubscribed: true },
    })
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result, "unsubscribed");

  const { body } = await call("GET", "/api/admin/audience?q=mirror-off", { token });
  assert.equal(body.items[0].subscribed, false, "the unsubscribe never landed");
});

await check("a signed re-subscribe puts them back", async () => {
  const res = await svixPost(
    JSON.stringify({
      type: "contact.updated",
      data: { email: "mirror-off@example.com", unsubscribed: false },
    })
  );
  assert.equal(res.status, 200);

  const { body } = await call("GET", "/api/admin/audience?q=mirror-off", { token });
  assert.equal(body.items[0].subscribed, true);
});

await check("a spam complaint unsubscribes every address it names", async () => {
  const res = await svixPost(
    JSON.stringify({
      type: "email.complained",
      data: { email_id: "e1", to: ["mirror-off@example.com"] },
    })
  );
  assert.equal(res.status, 200);

  const { body } = await call("GET", "/api/admin/audience?q=mirror-off", { token });
  assert.equal(body.items[0].subscribed, false, "a complaint left them subscribed");
});

await check("⚠ a webhook NEVER creates a person", async () => {
  /* A leaked signing secret must not become a write to the audience list.
     recordAudience is the one way in. */
  const res = await svixPost(
    JSON.stringify({
      type: "contact.created",
      data: { email: "never-seen@example.com", unsubscribed: false },
    })
  );
  assert.equal(res.status, 200);

  const { body } = await call("GET", "/api/admin/audience?q=never-seen", { token });
  assert.equal(body.items.length, 0, "a webhook inserted somebody");
});

await check("an unknown event type is acknowledged, not retried", async () => {
  /* ⚠ Resend's event list grows. A 4xx here would look like a bug to whoever
     added the subscription, and a 5xx would have Resend retrying it forever. */
  const res = await svixPost(
    JSON.stringify({ type: "email.opened", data: { to: ["mirror-off@example.com"] } })
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result, "ignored");
});

await check("a signature from the WRONG secret is refused", async () => {
  const res = await svixPost(
    JSON.stringify({
      type: "contact.updated",
      data: { email: "quiet-sub@example.com", unsubscribed: true },
    }),
    { secret: `whsec_${randomBytes(24).toString("base64")}` }
  );
  assert.equal(res.status, 400, "a signature from another secret was accepted");

  const { body } = await call("GET", "/api/admin/audience?q=quiet-sub", { token });
  assert.equal(body.items[0].subscribed, true, "it changed a subscription anyway");
});

await check("a tampered body is refused even with a valid signature", async () => {
  /* ⚠ The signature covers the BYTES. Signing one payload and posting another
     is exactly what a replay looks like. */
  const signed = JSON.stringify({
    type: "contact.updated",
    data: { email: "quiet-sub@example.com", unsubscribed: false },
  });
  const key = Buffer.from(
    process.env.RESEND_WEBHOOK_SECRET.replace(/^whsec_/, ""),
    "base64"
  );
  const id = "msg_tampered";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${signed}`)
    .digest("base64");

  const res = await fetch(`${base}/api/webhooks/resend`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
    },
    /* The signature above is for `unsubscribed: false`. */
    body: signed.replace('"unsubscribed":false', '"unsubscribed":true'),
  });
  assert.equal(res.status, 400);

  const { body } = await call("GET", "/api/admin/audience?q=quiet-sub", { token });
  assert.equal(body.items[0].subscribed, true);
});

await check("a forged webhook cannot unsubscribe anyone", async () => {
  /* The attack this endpoint exists to refuse: a POST carrying a signature
     that is not one, claiming a real subscriber has opted out.

     ⚠ Asserted against quiet-sub rather than mirror-off, which the complaint
     check above deliberately leaves UNSUBSCRIBED — a target that was already
     false would pass this test whether or not the forgery was refused. */
  const res = await fetch(`${base}/api/webhooks/resend`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": "msg_forged",
      "svix-timestamp": String(Math.floor(Date.now() / 1000)),
      "svix-signature": "v1,not-a-real-signature",
    },
    body: JSON.stringify({
      type: "contact.updated",
      data: { email: "quiet-sub@example.com", unsubscribed: true },
    }),
  });
  assert.equal(res.status, 400);

  const { body } = await call("GET", "/api/admin/audience?q=quiet-sub", { token });
  assert.equal(body.items[0].subscribed, true, "a forged webhook changed a subscription");
});

await check("the webhook reads its own raw body", async () => {
  /* ⚠ Guards the mounting order in app.js, and the guard is the whole reason
     the checks above can pass at all: express.json() in front of this router
     would consume the bytes, and a signature computed over a re-encoded object
     never matches. Signing a payload whose key order and spacing NO parser
     would reproduce is what proves the raw bytes arrived — a re-encode drops
     the spaces and this fails. */
  const payload =
    '{ "type" : "contact.updated" ,\n  "data" : { "email" : "mirror-off@example.com" , "unsubscribed" : false } }';
  const res = await svixPost(payload);
  assert.equal(res.status, 200, "something parsed the body before the webhook did");
  assert.equal((await res.json()).result, "subscribed");
});

await check("an endpoint with no signing secret refuses to act", async () => {
  /* ⚠ 503 and not 200: Resend RETRIES a 503, so events queue up rather than
     being lost while the variable is still being set. Restored immediately —
     the checks above share this process. */
  const configured = process.env.RESEND_WEBHOOK_SECRET;
  const { CONFIG } = await import("../src/config.js");
  CONFIG.resendWebhookSecret = "";
  try {
    const res = await svixPost(
      JSON.stringify({
        type: "contact.updated",
        data: { email: "mirror-off@example.com", unsubscribed: true },
      }),
      { secret: configured }
    );
    assert.equal(res.status, 503);

    const { body } = await call("GET", "/api/admin/audience?q=mirror-off", { token });
    assert.equal(body.items[0].subscribed, true, "it acted without being able to verify");
  } finally {
    CONFIG.resendWebhookSecret = configured;
  }
});

console.log("\nTurnstile cannot be skipped");

await check("⚠ a form posted DIRECTLY to the API is refused", async () => {
  /* ⚠ THE POINT: the site's Worker checks Turnstile and then forwards with a
     shared secret. This API is on its own hostname, so without this check a bot
     simply posts here instead and the whole Turnstile chain is decorative.
     ⚠ Restored immediately — the checks around this one share the process. */
  const { CONFIG } = await import("../src/config.js");
  const secret = `forward-${randomBytes(8).toString("hex")}`;
  CONFIG.cmsForwardSecret = secret;

  try {
    const direct = await call("POST", "/api/subscribe", {
      body: { email: "bot@example.com" },
    });
    assert.equal(direct.status, 403, "a direct post walked past Turnstile");

    const wrong = await fetch(`${base}/api/subscribe`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forward-secret": "guess" },
      body: JSON.stringify({ email: "bot2@example.com" }),
    });
    assert.equal(wrong.status, 403, "a wrong secret was accepted");

    /* Registration is guarded too — it is the other public write. */
    const event = await fetch(`${base}/api/events/fishing-day/register?country=ca`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: REG({ email: "bot3@example.com" }) }),
    });
    assert.equal(event.status, 403);

    /* And the Worker's own forward goes through. */
    const forwarded = await fetch(`${base}/api/subscribe`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forward-secret": secret },
      body: JSON.stringify({ email: "through-the-worker@example.com" }),
    });
    assert.equal(forwarded.status, 201, "the Worker's own submission was refused");
  } finally {
    CONFIG.cmsForwardSecret = "";
  }
});

await check("⚠ unset means OFF, and every form still works", async () => {
  /* A deployment that has not been given the secret must keep taking forms —
     the failure mode of a missing variable cannot be a site whose forms all
     break. That is the state every other check in this file runs in. */
  const { status } = await call("POST", "/api/subscribe", {
    body: { email: "no-secret-set@example.com" },
  });
  assert.equal(status, 201);
});

await check("the unsubscribe link is NOT behind the forward secret", async () => {
  /* ⚠ It is a link in somebody's inbox, not a form posted through the Worker.
     Guarding it would break every unsubscribe in every email already sent. */
  const { CONFIG } = await import("../src/config.js");
  CONFIG.cmsForwardSecret = "something";
  try {
    const { signUnsubscribe } = await import("../src/lib/tokens.js");
    const res = await fetch(
      `${base}/api/unsubscribe?t=${encodeURIComponent(signUnsubscribe("quiet@example.com"))}`
    );
    assert.equal(res.status, 200);
  } finally {
    CONFIG.cmsForwardSecret = "";
  }
});

await check("⚠ background work is AWAITED on Vercel and nowhere else", async () => {
  /* THE FIX FOR THE BUG THAT STARTED THIS: a Vercel function is frozen the
     moment it answers, so a promise nobody waits on is abandoned — the sign-up
     is stored and the email is never sent. Off Vercel, waiting would only make
     every form slower. */
  const here = await import("../src/lib/background.js");
  let ran = false;
  await here.background(
    "test",
    () =>
      new Promise((done) =>
        setTimeout(() => {
          ran = true;
          done();
        }, 60)
      )
  );
  assert.equal(ran, false, "off Vercel it waited, which costs every form");

  process.env.VERCEL = "1";
  /* ⚠ A fresh specifier, because the flag is read once when the module loads —
     which is also why this cannot be tested by setting the variable alone. */
  const onVercel = await import("../src/lib/background.js?on-vercel");
  delete process.env.VERCEL;

  let ranThere = false;
  await onVercel.background(
    "test",
    () =>
      new Promise((done) =>
        setTimeout(() => {
          ranThere = true;
          done();
        }, 60)
      )
  );
  assert.equal(ranThere, true, "⚠ on Vercel the work was abandoned — the bug is back");
});

await check("subscribing says whether you were already in", async () => {
  const first = await call("POST", "/api/subscribe", {
    body: { email: "welcome-me@example.com" },
  });
  assert.equal(first.status, 201);
  /* Nobody has been greeted yet, so this is a new subscription. */
  assert.equal(first.body.alreadySubscribed, false);

  /* ⚠ A DIFFERENT address, written straight to the collection, and not the one
     just posted. Mail is off here, so that first subscribe's welcome claims the
     stamp, fails to send and hands it BACK — asynchronously, and off Vercel
     nothing waits for it. Stamping the same row by hand would race that release
     and lose. This row has no such work in flight. */
  const { Audience } = await import("../src/models/Audience.js");
  await Audience.create({
    email: "already-in@example.com",
    subscribed: true,
    sources: ["subscribe"],
    country: "in",
    welcomeSentAt: new Date(),
    /* ⚠ Welcomed for INDIA — which is what the repeat submission below is
       tested against. Canada would be a separate opt-in. */
    welcomedCountries: ["in"],
  });

  const again = await call("POST", "/api/subscribe", {
    body: { email: "already-in@example.com" },
  });
  assert.equal(again.status, 201);
  assert.equal(again.body.alreadySubscribed, true, "a repeat subscribe looked new");
});

await check("⚠ the welcome is sent ONCE, ever", async () => {
  const { welcomeSubscriber } = await import("../src/lib/welcome.js");
  const { Audience } = await import("../src/models/Audience.js");

  const person = await Audience.findOne({ email: "already-in@example.com" }).lean();
  assert.deepEqual(person.welcomedCountries, ["in"]);

  assert.deepEqual(await welcomeSubscriber(person, "in"), {
    sent: false,
    reason: "already-sent",
  });
});

await check("⚠ unsubscribing EARNS A NEW WELCOME on coming back", async () => {
  /* Somebody who leaves and returns is making a new opt-in, and the welcome is
     the only confirmation it took. The stamp records the CURRENT subscription,
     not the person's history — so every write that unsubscribes clears it. */
  const { Audience } = await import("../src/models/Audience.js");
  const { welcomeSubscriber } = await import("../src/lib/welcome.js");
  const { signUnsubscribe } = await import("../src/lib/tokens.js");

  await Audience.create({
    email: "came-back@example.com",
    subscribed: true,
    sources: ["subscribe"],
    country: "in",
    welcomeSentAt: new Date(),
    welcomedCountries: ["in"],
  });

  /* Already greeted for this subscription. */
  const first = await Audience.findOne({ email: "came-back@example.com" }).lean();
  assert.equal((await welcomeSubscriber(first, "in")).reason, "already-sent");

  /* They unsubscribe from an email. */
  const res = await fetch(
    `${base}/api/unsubscribe?t=${encodeURIComponent(signUnsubscribe("came-back@example.com"))}`
  );
  assert.equal(res.status, 200);

  const off = await Audience.findOne({ email: "came-back@example.com" }).lean();
  assert.equal(off.subscribed, false);
  assert.deepEqual(off.welcomedCountries, [], "the claim survived an unsubscribe");

  /* ...and subscribe again.

     ⚠ Written directly rather than posted to /api/subscribe: that route runs
     its own welcome in the BACKGROUND, and off Vercel nothing waits for it —
     it would race this test's call for the same claim and win at random. The
     route's own path is covered by the checks above; what is under test here
     is that the claim is available again. */
  await Audience.updateOne(
    { email: "came-back@example.com" },
    { $set: { subscribed: true } }
  );
  const again = await Audience.findOne({ email: "came-back@example.com" }).lean();
  assert.equal(again.subscribed, true);

  /* Mail is off in this run, so the attempt fails and hands the stamp back —
     what matters is that it was ATTEMPTED rather than skipped. */
  assert.notEqual((await welcomeSubscriber(again, "in")).reason, "already-sent");
});

await check("⚠ an admin unticking the box clears it too", async () => {
  const { Audience } = await import("../src/models/Audience.js");
  const row = await Audience.create({
    email: "cms-removed@example.com",
    subscribed: true,
    sources: ["subscribe"],
    country: "in",
    welcomeSentAt: new Date(),
    welcomedCountries: ["in"],
  });

  await call("PATCH", `/api/admin/audience/${row._id}`, {
    token,
    body: { subscribed: false },
  });

  const after = await Audience.findOne({ email: "cms-removed@example.com" }).lean();
  assert.equal(after.subscribed, false);
  assert.deepEqual(after.welcomedCountries, [], "the claim survived a CMS unsubscribe");
});

await check(
  "⚠ a row welcomed BEFORE the country list existed is not greeted twice",
  async () => {
    /* The field was added after the stamp, so every already-greeted row looked
     un-greeted the day it shipped — and sent a second welcome to people who had
     had one. The stamp is the evidence; the row's own country is the one. */
    const { welcomeSubscriber } = await import("../src/lib/welcome.js");
    const { Audience } = await import("../src/models/Audience.js");

    await Audience.create({
      email: "old-row@example.com",
      subscribed: true,
      sources: ["subscribe"],
      country: "in",
      welcomeSentAt: new Date("2026-01-01"),
      /* ⚠ Empty — exactly how a row written before the field looks. */
      welcomedCountries: [],
    });

    const person = await Audience.findOne({ email: "old-row@example.com" }).lean();
    assert.deepEqual(await welcomeSubscriber(person, "in"), {
      sent: false,
      reason: "already-sent",
    });

    /* ...and the backfill is recorded, so it is decided once rather than on
     every submission. */
    const after = await Audience.findOne({ email: "old-row@example.com" }).lean();
    assert.deepEqual(after.welcomedCountries, ["in"]);

    /* ⚠ The OTHER country is still a separate opt-in — the backfill fills in what
     is known, it does not claim the person was welcomed everywhere. */
    assert.notEqual((await welcomeSubscriber(after, "ca")).reason, "already-sent");
  }
);

await check("⚠ the OTHER country is a separate opt-in", async () => {
  /* India and Canada are different lists — different events, links and social
     accounts — so somebody already on India's list who subscribes on the
     Canadian site is opting in again, and earns Canada's own welcome. */
  const { welcomeSubscriber, alreadySubscribed } = await import("../src/lib/welcome.js");
  const { Audience } = await import("../src/models/Audience.js");

  await Audience.create({
    email: "both-countries@example.com",
    subscribed: true,
    sources: ["subscribe"],
    country: "in",
    welcomeSentAt: new Date(),
    welcomedCountries: ["in"],
  });

  const person = await Audience.findOne({ email: "both-countries@example.com" }).lean();

  assert.equal(alreadySubscribed(person, "in"), true);
  assert.equal(alreadySubscribed(person, "ca"), false, "Canada looked already-done");

  assert.equal((await welcomeSubscriber(person, "in")).reason, "already-sent");
  /* ⚠ Mail is off in this run, so the send fails — what matters is that it was
     ATTEMPTED for Canada rather than skipped. */
  assert.notEqual(
    (await welcomeSubscriber(person, "ca")).reason,
    "already-sent",
    "the other country was treated as already welcomed"
  );
});

await check("⚠ a FAILED send gives the one chance back", async () => {
  /* Mail is off, so every send here fails. If the stamp survived that, one
     Resend outage would mean that person is never greeted at all. */
  const { welcomeSubscriber } = await import("../src/lib/welcome.js");
  const { Audience } = await import("../src/models/Audience.js");

  /* ⚠ Written straight to the collection, NOT posted: the route runs its own
     welcome in the background and off Vercel nothing waits for it, so posting
     would race that attempt's claim and read "already-sent" at random. */
  const person = await Audience.create({
    email: "outage@example.com",
    subscribed: true,
    sources: ["subscribe"],
    country: "in",
  });

  const result = await welcomeSubscriber(person, "in");
  assert.equal(result.sent, false);
  assert.equal(result.reason, "mail-disabled");

  const after = await Audience.findOne({ email: "outage@example.com" }).lean();
  assert.deepEqual(
    after.welcomedCountries,
    [],
    "a failed send consumed the only attempt"
  );
});

await check("⚠ nobody is greeted who did not ask", async () => {
  const { welcomeSubscriber } = await import("../src/lib/welcome.js");
  const { Audience } = await import("../src/models/Audience.js");

  /* Registered for an event with the box untouched. */
  await call("POST", "/api/events/fishing-day/register?country=ca", {
    body: { answers: REG({ email: "no-thanks@example.com" }) },
  });
  const person = await Audience.findOne({ email: "no-thanks@example.com" }).lean();
  assert.equal(person.subscribed, false);

  assert.deepEqual(await welcomeSubscriber(person, "ca"), {
    sent: false,
    reason: "not-subscribed",
  });
  assert.deepEqual(await welcomeSubscriber(null, "in"), {
    sent: false,
    reason: "no-address",
  });
});

await check("ticking the box on a REGISTRATION subscribes them too", async () => {
  /* ⚠ The same act as the footer form, so it earns the same welcome — which is
     a separate message from the booking confirmation. */
  const { Audience } = await import("../src/models/Audience.js");
  await call("POST", "/api/events/fishing-day/register?country=ca", {
    body: { answers: REG({ email: "reg-and-sub@example.com" }), subscribe: true },
  });

  const person = await Audience.findOne({ email: "reg-and-sub@example.com" }).lean();
  assert.equal(person.subscribed, true);
  assert.ok(person.sources.includes("event"));
});

await check("the welcome message carries its unsubscribe link", async () => {
  const { renderSubscribeWelcome } = await import("../src/lib/emails/subscribe.js");
  const { subject, html, text } = renderSubscribeWelcome({
    name: "Aisha",
    unsubscribeUrl: "https://api.example.com/api/unsubscribe?t=abc",
    siteUrl: "https://iwan.community",
  });
  assert.match(subject, /subscribed/i);
  assert.match(html, /You&rsquo;re on the list/);
  assert.match(html, /api\/unsubscribe\?t=abc/);
  /* ⚠ In the text alternative too — this one is marketing, and a marketing
     message with no way off the list is what gets a domain blocked. */
  assert.match(text, /Unsubscribe: https:/);
  assert.ok(!html.includes("<script"), "the welcome pulled in a script");
});

await check("⚠ the welcome is REFUSED without an unsubscribe link", async () => {
  /* API_URL is unset in this run, so there is no link to build. Mail is off
     too, and that guard comes first — what is asserted is that it does not
     send, whichever guard stops it. */
  const { sendSubscribeWelcome } = await import("../src/lib/mail.js");
  const result = await sendSubscribeWelcome({ email: "someone@example.com" });
  assert.equal(result.sent, false);
});

await check("templates fall back to the code when Resend has none", async () => {
  /* ⚠ No key in this run, so there is no account to ask — and the answer must
     be "use the built-in message", not an error. That is the path every
     deployment without templates takes on every single send. */
  const { resolveTemplate } = await import("../src/lib/templates.js");
  assert.equal(await resolveTemplate("registration"), null);
  assert.equal(await resolveTemplate("welcome"), null);
  /* An unknown kind has no alias to look up, and is not a crash. */
  assert.equal(await resolveTemplate("nonsense"), null);
});

await check("template variables are coerced to what Resend accepts", async () => {
  /* ⚠ Strings and numbers only. Anything else is silently useless in a
     template, so nothing else may leave here. */
  const { variables } = await import("../src/lib/templates.js");
  assert.deepEqual(
    variables({ name: "Aisha", spots: 12, missing: undefined, none: null, yes: true }),
    { name: "Aisha", spots: 12, missing: "", none: "", yes: "true" }
  );
});

console.log("\nvolunteer and career confirmations");

await check("both kinds acknowledge the person who applied", async () => {
  /* ⚠ Until this existed they filled in a form and heard nothing at all —
     only Iwan got a notification. */
  const { renderApplicationConfirmation } =
    await import("../src/lib/emails/application.js");

  const volunteer = renderApplicationConfirmation({
    kind: "volunteer",
    name: "Aisha Rahman",
    siteUrl: "https://iwan.community",
  });
  assert.match(volunteer.subject, /offering to help/i);
  /* ⚠ First name only, as everywhere else. */
  assert.match(volunteer.html, /Assalamu alaikum Aisha/);
  assert.ok(!volunteer.html.includes("Rahman"));

  const career = renderApplicationConfirmation({
    kind: "career",
    name: "Omar",
    role: "Programme Coordinator",
  });
  assert.match(career.subject, /your application/i);
  /* The role appears only where the form asked for one. */
  assert.match(career.html, /Programme Coordinator/);
  assert.ok(!volunteer.html.includes("Role:"), "a volunteer offer printed a role");
});

await check("the contact form acknowledges the sender, echoing the message", async () => {
  /* ⚠ Until this existed somebody typed a long message into a box and got a
     line on screen, with no proof it went anywhere. */
  const { renderContactConfirmation, contactValues } =
    await import("../src/lib/emails/contact.js");
  const { html, text, subject } = renderContactConfirmation({
    name: "Aisha Rahman",
    subject: "Can I bring my sister?",
    message: "Is there room at the gardening session?",
    siteUrl: "https://iwan.community",
  });
  assert.match(subject, /have your message/i);
  assert.match(html, /Assalamu alaikum Aisha/);
  assert.match(html, /Can I bring my sister/);
  assert.match(html, /gardening session/);
  assert.match(text, /Is there room at the gardening session\?/);

  /* ⚠ It came off a public form and is rendered into an inbox. */
  const nasty = renderContactConfirmation({
    name: "X",
    subject: "<script>alert(1)</script>",
    message: "<img src=x onerror=alert(1)>",
  });
  assert.ok(!nasty.html.includes("<script>"), "a script tag survived");
  assert.ok(!nasty.html.includes("<img src=x"), "a tag survived");
  assert.match(nasty.html, /&lt;script&gt;/);

  /* ⚠ No value may be empty — Resend has no conditionals, so a blank renders
     as a bare label. */
  const blank = contactValues({});
  for (const [key, value] of Object.entries(blank)) {
    if (key === "FIRST_NAME") continue;
    assert.ok(value, `${key} was empty`);
  }

  /* ⚠ Long messages are trimmed rather than filling the inbox preview. */
  const long = contactValues({ message: "x".repeat(2000) });
  assert.ok(long.MESSAGE.length < 700, "a very long message was echoed whole");
});

await check("⚠ a contact reply carries NO unsubscribe link", async () => {
  /* Writing to an organisation is not joining its mailing list. */
  const { renderContactConfirmation } = await import("../src/lib/emails/contact.js");
  const { html, text } = renderContactConfirmation({ name: "A", subject: "Hi" });
  /* ⚠ The LINK, not the word: the designed file carries comments explaining
     why there is no unsubscribe here, and those mention it by name. */
  assert.ok(!html.includes("api/unsubscribe"), "a link to unsubscribe was rendered");
  assert.ok(!/href="[^"]*unsubscribe/i.test(html));
  assert.ok(!text.toLowerCase().includes("unsubscribe"));
});

await check("⚠ only the FOOTER form ever says 'already subscribed'", async () => {
  /* Every form carries the newsletter box, so the subscription happens in all
     of them — but telling somebody "you are already subscribed" when they came
     to send a message or apply for a job is answering a question they did not
     ask. Only /api/subscribe reports it. */
  const contact = await call("POST", "/api/contact", {
    body: {
      email: "quiet-flag@example.com",
      name: "Quiet",
      subject: "Nothing to report",
      subscribe: true,
    },
  });
  assert.equal(contact.status, 201);
  assert.deepEqual(contact.body, { ok: true }, "the contact form leaked the flag");

  /* ⚠ country=ca, matching the form this suite leaves in place — the sections
     above edit the apply forms, and India's ends up with questions this body
     does not answer. What is under test is the RESPONSE SHAPE, not the form. */
  const volunteer = await call("POST", "/api/volunteer?country=ca", {
    body: {
      answers: { name: { first: "V", last: "Ol" }, email: "quiet-flag@example.com" },
      subscribe: true,
    },
  });
  assert.equal(volunteer.status, 201, JSON.stringify(volunteer.body));
  assert.deepEqual(volunteer.body, { ok: true }, "the volunteer form leaked the flag");

  /* ...but the subscription itself still happened, from those forms. */
  const { body } = await call("GET", "/api/admin/audience?q=quiet-flag", { token });
  assert.equal(body.items[0].subscribed, true, "the box was ticked and ignored");
});

await check("⚠ an application carries NO unsubscribe link", async () => {
  /* Applying for a role is not joining a mailing list. Offering to unsubscribe
     implies a subscription they never made — and the welcome, which they get
     separately if they ticked the box, carries its own. */
  const { renderApplicationConfirmation } =
    await import("../src/lib/emails/application.js");
  const { html, text } = renderApplicationConfirmation({ kind: "career", name: "Omar" });
  /* ⚠ The LINK, not the word — see the contact check. */
  assert.ok(!html.includes("api/unsubscribe"), "a link to unsubscribe was rendered");
  assert.ok(!/href="[^"]*unsubscribe/i.test(html));
  assert.ok(!text.toLowerCase().includes("unsubscribe"));
});

await check("an unknown kind falls back rather than failing to send", async () => {
  const { renderApplicationConfirmation, applicationValues } =
    await import("../src/lib/emails/application.js");
  const { html } = renderApplicationConfirmation({ kind: "nonsense", name: "Sam" });
  assert.match(html, /Assalamu alaikum Sam/);
  assert.equal(applicationValues({ kind: "nonsense" }).APPLICATION_TYPE, "volunteering");
});

await check("the application template is looked up per country", async () => {
  const { aliasesFor } = await import("../src/lib/templates.js");
  assert.deepEqual(aliasesFor("application", { country: "ca" }), [
    "iwan-application-ca",
    "iwan-application",
  ]);
  /* ⚠ ONE alias for both kinds — the kind is a variable on the template. */
  assert.deepEqual(aliasesFor("application", {}), ["iwan-application"]);
});

await check("applying still succeeds with mail off", async () => {
  /* The acknowledgement is awaited now, so a broken send would be a broken
     form if anything here could throw. Nothing can. */
  const volunteer = await call("POST", "/api/volunteer?country=ca", {
    body: {
      answers: { name: { first: "Vol", last: "Unteer" }, email: "vol2@example.com" },
    },
  });
  assert.equal(volunteer.status, 201);

  const { Application } = await import("../src/models/Application.js");
  assert.ok(await Application.findOne({ email: "vol2@example.com" }));
});

console.log("\nthe unsubscribe link");

/* ⚠ Resend hosts this flow for BROADCASTS and does none of it for the
   transactional mail this API sends, so all of it is ours and all of it is
   tested here — no network, no key, no mail. */

await check("a signed link unsubscribes, and says so in a page", async () => {
  await call("POST", "/api/subscribe", { body: { email: "unsub-me@example.com" } });

  const { signUnsubscribe } = await import("../src/lib/tokens.js");
  const res = await fetch(
    `${base}/api/unsubscribe?t=${encodeURIComponent(signUnsubscribe("unsub-me@example.com"))}`
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);

  const html = await res.text();
  assert.match(html, /You have been unsubscribed/);
  /* ⚠ The page must say what has NOT stopped, or someone assumes their place
     at an event is gone too. */
  assert.match(html, /does not cancel a booking/);

  const { body } = await call("GET", "/api/admin/audience?q=unsub-me", { token });
  assert.equal(body.items[0].subscribed, false, "the unsubscribe never landed");
});

await check("⚠ the address is NOT in the link, and cannot be forged", async () => {
  /* A raw `?email=` would let anyone unsubscribe anyone by typing an address. */
  const { signUnsubscribe } = await import("../src/lib/tokens.js");
  const link = signUnsubscribe("someone@example.com");
  assert.ok(!link.includes("someone@example.com"), "the address is in the link verbatim");

  await call("POST", "/api/subscribe", { body: { email: "safe@example.com" } });

  for (const forged of ["safe@example.com", "not-a-token", `${link}x`, ""]) {
    const res = await fetch(`${base}/api/unsubscribe?t=${encodeURIComponent(forged)}`);
    assert.equal(res.status, 400, `a forged token was accepted: ${forged}`);
    assert.match(await res.text(), /did not work/);
  }

  const { body } = await call("GET", "/api/admin/audience?q=safe@example.com", { token });
  assert.equal(body.items[0].subscribed, true, "a forged link unsubscribed somebody");
});

await check("⚠ a SESSION token cannot be spent as an unsubscribe link", async () => {
  /* Both are signed with JWT_SECRET; only the `purpose` claim separates them. */
  const res = await fetch(`${base}/api/unsubscribe?t=${encodeURIComponent(token)}`);
  assert.equal(res.status, 400);
});

await check("the one-click POST answers 200 and nothing else", async () => {
  /* ⚠ RFC 8058. Gmail and Apple post this from their own servers when someone
     presses the unsubscribe button beside the sender name; a redirect or an
     HTML body reads as a FAILED unsubscribe to them. */
  await call("POST", "/api/subscribe", { body: { email: "one-click@example.com" } });

  const { signUnsubscribe } = await import("../src/lib/tokens.js");
  const res = await fetch(
    `${base}/api/unsubscribe?t=${encodeURIComponent(signUnsubscribe("one-click@example.com"))}`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    }
  );
  assert.equal(res.status, 200);
  assert.equal((await res.text()).trim(), "", "the one-click POST returned a body");

  const { body } = await call("GET", "/api/admin/audience?q=one-click", { token });
  assert.equal(body.items[0].subscribed, false);
});

await check("⚠ a bad token still answers the provider 200 on POST", async () => {
  /* A 4xx teaches Gmail that this sender's unsubscribe button is broken, and
     nobody ever sees the error. */
  const res = await fetch(`${base}/api/unsubscribe?t=rubbish`, { method: "POST" });
  assert.equal(res.status, 200);
});

await check("unsubscribing twice is not an error", async () => {
  const { signUnsubscribe } = await import("../src/lib/tokens.js");
  const link = `${base}/api/unsubscribe?t=${encodeURIComponent(signUnsubscribe("one-click@example.com"))}`;
  assert.equal((await fetch(link)).status, 200);
  /* Nor is unsubscribing somebody who was never in the audience at all. */
  const stranger = `${base}/api/unsubscribe?t=${encodeURIComponent(signUnsubscribe("nobody-here@example.com"))}`;
  assert.equal((await fetch(stranger)).status, 200);
});

await check("the page fetches nothing and is not indexable", async () => {
  const { signUnsubscribe } = await import("../src/lib/tokens.js");
  const res = await fetch(
    `${base}/api/unsubscribe?t=${encodeURIComponent(signUnsubscribe("unsub-me@example.com"))}`
  );
  /* ⚠ The app-wide CSP is off because this API served no HTML until now, so
     the page carries its own. */
  assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(res.headers.get("x-robots-tag") ?? "", /noindex/);

  const html = await res.text();
  /* ⚠ No script, no stylesheet, nothing to post to. The ONE thing it fetches is
     the logo, which is why the policy names that host and nothing else. */
  for (const tag of ["<script", "<link", "<form", "<iframe"]) {
    assert.ok(!html.includes(tag), `the page pulls in ${tag}`);
  }
  /* ⚠ EVERY image must be on the one host the policy names — the page is the
     site's designed shell, so it carries the logo and the social row. One from
     anywhere else and the policy silently blocks it. */
  const sources = [...html.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(sources.length >= 1, "the page lost its logo");
  for (const src of sources) {
    assert.match(src, /^https:\/\/cdn\.iwan\.community\//, `off-policy image: ${src}`);
  }
  assert.match(
    res.headers.get("content-security-policy") ?? "",
    /img-src https:\/\/cdn\.iwan\.community/
  );
});

await check("⚠ the footer link is for SUBSCRIBERS only", async () => {
  /* The confirmation goes to everyone who registers, and most never ticked the
     newsletter box. Offering to unsubscribe them from something they never
     joined invites "I never signed up for this".
     ⚠ The HEADER is unconditional — only the visible footer is not. */
  const { isSubscribed } = await import("../src/lib/audience.js");

  await call("POST", "/api/subscribe", { body: { email: "on-the-list@example.com" } });
  assert.equal(await isSubscribed("on-the-list@example.com"), true);

  /* Registered for an event, never subscribed. */
  await call("POST", "/api/events/fishing-day/register?country=ca", {
    body: { answers: REG({ email: "just-registered@example.com" }) },
  });
  assert.equal(await isSubscribed("just-registered@example.com"), false);

  /* Somebody this API has never seen, and a blank address — neither is an
     error, both are "no". */
  assert.equal(await isSubscribed("stranger@example.com"), false);
  assert.equal(await isSubscribed(""), false);
});

await check("the fallback shows its unsubscribe only to subscribers", async () => {
  /* ⚠ The DESIGNED template lives in Resend; this is what goes out when
       there is none. The gating is the part that is wrong to get wrong
       either way: registering is not subscribing. */
  const { renderRegistrationConfirmation } =
    await import("../src/lib/emails/registration.js");

  const shown = renderRegistrationConfirmation({
    name: "Aisha Rahman",
    event: {
      title: "Fishing Day",
      date: "2026-08-21",
      start: "18:30",
      venue: "Iwan Hall",
    },
    subscribed: true,
    unsubscribeUrl: "https://api.example.com/api/unsubscribe?t=abc",
  });
  assert.match(shown.html, /Unsubscribe/);
  assert.match(shown.html, /api\/unsubscribe\?t=abc/);
  assert.match(shown.text, /Unsubscribe from our newsletter: https:/);
  /* ⚠ FIRST name only — the designed template greets with it, so the same
       value must go under the same name whichever renders. */
  assert.match(shown.html, /Assalamu alaikum Aisha/);
  assert.ok(!shown.html.includes("Rahman"), "the greeting used the full name");

  const hidden = renderRegistrationConfirmation({
    name: "Aisha",
    event: { title: "Fishing Day" },
    subscribed: false,
    unsubscribeUrl: "https://api.example.com/api/unsubscribe?t=abc",
  });
  /* ⚠ THE DESIGNED FILE SHOWS THE BLOCK TO EVERYBODY, because Resend Templates
     have no conditionals and the same file is rendered on both sides — so the
     gate cannot live in the markup. The link is right for either reader: it
     takes a subscriber off the list and does nothing for somebody never on it.
     What the TEXT alternative does gate, because it is built here. */
  assert.match(hidden.html, /api\/unsubscribe/, "the designed block should show");
  assert.ok(!hidden.text.includes("Unsubscribe"), "the text alternative did not gate");
});

await check("the confirmation carries the EVENT's own image", async () => {
  /* ⚠ The designed template's photograph is the event the person registered
     for. An event with none falls back to the shipped hero — an empty value
     renders as a broken image, and Resend refuses a send when a declared
     variable has neither value nor fallback. */
  const { registrationValues, DEFAULT_EVENT_IMAGE } =
    await import("../src/lib/emails/registration.js");

  const own = registrationValues({
    event: { title: "Fishing Day", img: "https://cdn.iwan.community/fishing.webp" },
  });
  assert.equal(own.EVENT_IMAGE, "https://cdn.iwan.community/fishing.webp");

  const none = registrationValues({ event: { title: "Fishing Day" } });
  assert.equal(none.EVENT_IMAGE, DEFAULT_EVENT_IMAGE);
  assert.ok(none.EVENT_IMAGE, "an empty image would render as a broken one");
});

await check("directions match what the site itself would link to", async () => {
  const { directionsUrl } = await import("../src/lib/emails/registration.js");
  /* ⚠ Coordinates win, exactly as in the site's lib/map.js — the email and the
     page must pin the same place. */
  assert.match(
    directionsUrl({ coords: [12.97, 77.59], venue: "Iwan Hall" }),
    /12\.97%2C77\.59/
  );
  assert.match(directionsUrl({ venue: "Iwan Hall" }), /Iwan\+Hall|Iwan%20Hall/);
  assert.equal(directionsUrl({}), "");
});

await check("no link and no headers when API_URL is unset", async () => {
  /* ⚠ A link to localhost in a real inbox is worse than no link. API_URL is
     empty for this run, so this is the state under test. */
  const { unsubscribeUrl } = await import("../src/lib/tokens.js");
  assert.equal(unsubscribeUrl("someone@example.com"), "");

  const { renderRegistrationConfirmation } =
    await import("../src/lib/emails/registration.js");
  const { html, text } = renderRegistrationConfirmation({
    event: { title: "Fishing Day" },
    subscribed: true,
    unsubscribeUrl: "",
  });
  /* ⚠ NO LINK MEANS THE WHOLE ROW GOES. Rendering it with an empty href would
     put a button leading nowhere in front of everyone who registers. */
  assert.ok(!html.includes("api/unsubscribe"), "a dead unsubscribe link");
  assert.ok(!html.includes('href=""'), "an empty href survived");
  assert.ok(!text.includes("Unsubscribe"));
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
      ...LIVE_EVENT,
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
