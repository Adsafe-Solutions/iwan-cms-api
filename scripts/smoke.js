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

/* ⚠ EMPTIED, not left to the environment, and not for tidiness: config.js loads
   .env, so a developer with a real RESEND_API_KEY had this suite making LIVE
   Resend calls on every run. They bounced only because the fixtures use
   example.com — a deliverable address would email a real person.

   Assigning "" rather than deleting is what makes it stick: dotenv only fills
   in keys ABSENT from process.env. */
process.env.RESEND_API_KEY = "";
process.env.MAIL_FROM = "";

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

await check("an episode with only a VIDEO url is accepted", async () => {
  const { status, body } = await call("POST", "/api/admin/episodes", {
    token,
    body: {
      slug: "video-only",
      title: "Video only",
      countries: [],
      status: "published",
      video: "https://example.com/ep.mp4",
    },
  });
  assert.equal(status, 201);
  assert.equal(body.video, "https://example.com/ep.mp4");
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
      video: "https://example.com/ep.mp4",
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
    body: { video: "https://example.com/ep.mp4" },
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
  assert.equal(ep.video, "https://example.com/ep.mp4");
  assert.equal(ep.programme, "/iwan-youth");
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

console.log("\npromos");

await check("no eligible promo serves null, not an error", async () => {
  const { status, body } = await call("GET", "/api/promo?country=in");
  assert.equal(status, 200);
  assert.equal(body, null);
});

await check("a country promo beats a global one", async () => {
  await call("POST", "/api/admin/promos", {
    token,
    body: {
      slug: "global-promo",
      status: "published",
      heading: "Everywhere",
      mark: "promo",
      cta: { label: "Go", to: "/events" },
    },
  });
  await call("POST", "/api/admin/promos", {
    token,
    body: {
      slug: "ca-promo",
      status: "published",
      countries: ["ca"],
      heading: "Canada",
      mark: "promo",
      cta: { label: "Go", to: "/events" },
    },
  });

  const { body: ca } = await call("GET", "/api/promo?country=ca");
  assert.equal(ca.id, "ca-promo");

  const { body: india } = await call("GET", "/api/promo?country=in");
  assert.equal(india.id, "global-promo");
});

await check("a promo outside its window is not served", async () => {
  await call("POST", "/api/admin/promos", {
    token,
    body: {
      slug: "expired-promo",
      status: "published",
      countries: ["in"],
      heading: "Last",
      mark: "year",
      priority: 99,
      startsAt: "2020-01-01",
      endsAt: "2020-12-31",
      cta: { label: "Go", to: "/" },
    },
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
