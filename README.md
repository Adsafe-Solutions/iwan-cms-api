# iwan-cms-api

The CMS API behind [iwan.community](https://iwan.community) — events, blogs,
podcast episodes and promos, each of which can belong to India, Canada, both, or
everywhere.

Express + Mongoose on MongoDB Atlas, deployed as a normal always-on Node service
on Render. Two halves:

- **public, read-only, no auth** — everything the marketing site fetches. Only
  `published` documents are ever visible here.
- **`/api/admin`, behind a sign-in** — what the CMS admin UI talks to.

## Running it

```bash
npm install
cp .env.example .env          # fill in MONGODB_URI and JWT_SECRET
npm run dev                   # :4000, restarts on change

ADMIN_EMAIL=you@iwan.community ADMIN_PASSWORD='…' npm run create:admin
npm run seed                  # load the site's current static content

npm run smoke                 # 25 end-to-end checks on a throwaway in-memory DB
```

`npm run seed` reads the public site's own `src/content/base/*.js` files (from
`../iwan` by default, `--from=…` to point elsewhere) rather than a transcribed
copy, so the seeded database is exactly what the site ships today. It upserts on
slug, so it is safe to re-run; `npm run seed:reset` empties the content
collections first and never touches user accounts.

⚠⚠ **THERE IS ONE DATABASE, AND IT IS THE LIVE ONE.**

There is no dev/prod split — `iwan_cms` on the Atlas cluster is what the
deployed API serves AND what your machine connects to. That is a deliberate
choice for an organisation this size, but it removes the guard that used to make
the seed safe, so two things are now true that were not before:

- `npm run seed` **overwrites live content** with whatever the static files say.
- `npm run seed:reset` **deletes live content first**. There is nothing to fall
  back to.

Take a backup before either:

```bash
mongodump --uri="$MONGODB_URI" --out=./backup-$(date +%F)
```

⚠ **A seed OVERWRITES.** Name the type you actually mean:

```bash
npm run seed -- --only=blogs       # blogs · events · podcast · promos
```

Refreshing one type with the bare command silently resets the other three to
whatever the static files say, throwing away every edit made in the admin.
`--only` is the safe form from here on; the whole-database run is the exception.

## The public API

| route                       | returns                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /api/content?country=` | **everything for one country in one call** — `{ country, events, blogs, podcast, promo }` |
| `GET /api/events?country=`  | events, soonest first                                                                     |
| `GET /api/events/:slug`     | one event                                                                                 |
| `GET /api/blogs?country=`   | posts, newest first, undated last                                                         |
| `GET /api/blogs/:slug`      | one post                                                                                  |
| `GET /api/podcast?country=` | `{ title, description, cover, episodes }`                                                 |
| `GET /api/promo?country=`   | the one promo to show, or `null`                                                          |
| `GET /health`               | process and database state — what Render polls                                            |

`/api/content` is the one the site actually uses: it needs all four on first
paint, and four requests would only cost four round trips to say the same thing.

**The payloads reproduce the site's existing content shape exactly** — same field
names its `content/base/*.js` files use, so `resolveContent` can swap file for
API without a single component changing. Which means:

- `id` is the **slug**, not the Mongo id.
- an event's agenda and a post's body come back as **pairs**
  (`[["18:30", "Doors open"], …]`), not objects.
- `country` is a code, a list of codes, or **absent** for everywhere.
- fields with no value are **omitted**, not sent as `null`.

Responses carry `Cache-Control: max-age=60, stale-while-revalidate=300`, so a
publish reaches the site within a minute rather than instantly.

## Blog posts are HTML

Posts are written in a rich-text editor and stored as HTML in `html`.

⚠ **Sanitising happens on WRITE, in `src/lib/html.js`** — not on render. The
public site renders this with `dangerouslySetInnerHTML`, so unsanitised HTML
here is a stored XSS on every visitor to the post. Doing it on the write path
means the stored value is trustworthy for every consumer (the site, a future
feed, an email) and there is exactly one place to get it right. It runs in two
places on purpose: the Zod schema (so the length cap measures what will actually
be stored) and the Mongoose setter (so the seed, the migration and any script
are covered too).

It is an **allowlist** — `p h2 h3 h4 strong em u s ul ol li blockquote a code
pre img figure figcaption hr br`, `http/https/mailto/tel` only, every link
forced to `rel="noopener noreferrer"`. No `h1` (the page supplies the post's own
title as the h1), no `span`/`div`/`style` (pasted Word junk), and script-like
tags have their **contents** discarded, not just their tags.

⚠ **`body` in the public payload is DEPRECATED.** It is the old `[kind, text]`
pair format, now _derived_ from the HTML on the way out so the live site keeps
working until it is taught to render `html`. It is lossy — bold, links and
nesting flatten to plain text. Delete `htmlToBlocks` and that key together once
the site switches.

`npm run migrate:blog-html` converts pre-editor posts from blocks to HTML. It
only touches posts whose `html` is empty, so it is safe to re-run and cannot
overwrite a post an editor has since rewritten; `--dry` shows what it would do.
The original `body` blocks are left in place — this conversion happens once, and
keeping the source means it can be redone if the mapping turns out wrong.

## Countries

Every content document carries `countries: [String]`, and an **empty list means
every country**. One representation, easy to query, and it renders as a set of
checkboxes in the admin. `lib/countries.js` translates it back to the site's
`country` contract on the way out.

⚠ `COUNTRY_CODES` in `src/lib/countries.js` must stay in step with `COUNTRIES` in
the public site's `src/config/countries.js`. The codes are the contract between
the two.

## Accounts

There is no public sign-up. `npm run create:admin` makes the first account (and
resets its password if it already exists, which is the way back in after a
lockout); everyone else is created by an admin through `/api/admin/users`.

Two roles. An **admin** can do anything, including managing accounts. An
**editor** can only edit content, and if their `countries` list is non-empty they
are scoped to it — they cannot write to another country, and they cannot create a
**global** document either, since a global one shows in every country including
the ones they do not have.

Sessions are stateless JWTs in an `Authorization: Bearer` header — no cookie, so
no CSRF surface between the admin's origin and this one. The account is re-read
from the database on every request, so deactivating one takes effect at once.

⚠ A password change does **not** invalidate existing tokens; nothing revokes
them before they expire. Worth adding a token version the day these accounts
protect more than marketing copy.

## Deploying to Vercel

`api/index.js` is the entrypoint; `vercel.json` rewrites every path to it. The
project needs no build step — Vercel installs and invokes the function.

⚠ **`src/server.js` is not the entrypoint and cannot be.** It exports nothing
for a platform to call, opens a port, and ends in `process.exit(1)` on a
configuration problem — a crashed function on every request, whatever the
environment holds. The two entrypoints share `createApp()`; only the way they
start differs. Deleting either breaks one host.

Four things the platform makes different, all handled in `api/index.js`:

- **The connection is opened on the first request, not at boot**, and cached
  for the life of the instance (`connectDbOnce` in `db.js`) with
  `maxPoolSize: 1`. Many instances run at once, and one pool each is how an
  Atlas connection cap gets eaten.
- **Nothing throws at module scope.** A missing variable is served as a 503
  naming nothing, with the reason in the log.
- **Atlas Network Access must allow `0.0.0.0/0`.** A function's egress IP is
  not fixed, unlike a Render service's.
- **The function runs in `bom1` (Mumbai), beside the database.** The cluster is
  an M0 in AWS `ap-south-1`, which its own SRV hostname says out loud
  (`…-aws-aps1-…-m0-…`). ⚠ Region is chosen for the DATABASE, not the visitor:
  `/api/content` makes several queries, so each one pays the round trip twice
  over from a distant region. Vercel's default `iad1` puts Washington between
  a Bangalore visitor and a Mumbai database.
- **A request body over 4.5MB is rejected before the function runs**, so
  `MAX_UPLOAD_BYTES` drops to 4MB when `VERCEL` is set. The CMS checks the same
  limit in the browser (`VITE_MAX_UPLOAD_MB`) so an oversized image is refused
  with a sentence rather than a platform error page.

⚠ **Rate limiting weakens.** `express-rate-limit` counts in memory, and every
instance keeps its own, so the public-form limits stop being a global count.
Turnstile still gates every public form in front of this API, so the limiter is
the second line rather than the only one — but if it has to be exact, it needs
a shared store.

## Deploying to Render

Build `npm ci`, start `npm start`, health check path `/health`. Set `NODE_ENV`,
`MONGODB_URI`, `JWT_SECRET` and `CORS_ORIGINS` in the service's environment.

⚠ **One database, one service.** `iwan_cms` on the Atlas cluster is the whole
thing — the deployed API and local development both use it. Simpler to run, and
honest about the scale this operates at; the cost is that there is no safe place
to try a destructive command, so see the warning above about seeding.

Split it the day two people are editing content at once, or the day you want to
try a schema change against real data without risking it.

`config.js` refuses to boot in production on a missing `MONGODB_URI`, a missing
or placeholder `JWT_SECRET`, or an empty `CORS_ORIGINS` — an API no browser could
reach is a misconfiguration worth failing the deploy over.

## Layout

```
src/
  config.js          every env var, validated at boot
  db.js              the one Mongoose connection
  app.js             express wiring — helmet, cors, routes, error handling
  server.js          boot order and graceful shutdown
  models/            Event · Blog · Podcast (show + episodes) · Promo · User
  routes/
    public.js        the read-only API
    admin.js         everything behind a sign-in
    crud.js          the shared list/create/update/delete router
    auth.js          sign in, /me, change password
  lib/               countries · serialize · errors · tokens
  middleware/        auth · validate · error
  validators/        the Zod write schemas
scripts/             seed · create-admin · smoke
```

`routes/crud.js` is the reason there is no repetition between the four content
types: they differ in their fields and in nothing else, so a fifth type is a
model, a schema, a serialiser and one line in `routes/admin.js`.

## Gotchas worth knowing

- **Dates are `"YYYY-MM-DD"` strings, never `Date` objects.** The site parses
  them field-by-field precisely because `new Date("2026-08-21")` is read as UTC
  and lands a day early west of Greenwich. A `Date` here would round-trip through
  an ISO timestamp and reintroduce exactly that bug. An event happens on a
  calendar day in its own place; it is not an instant.
- **An event's `programme` is a nav path** (`/iwan-women`), not a label. The site
  resolves the label from the active country's nav, which is what keeps the chip,
  the filter and the programme page from disagreeing.
- **Promos are a list here and a singleton on the site.** The public endpoint
  resolves the one to show — country-specific beats global, then `priority`, then
  most recently edited — so `usePromo()` keeps the contract it has.
- **`passwordHash` is `select: false`.** Anything that needs it has to ask by
  name, so no ordinary query can leak it into a response.
- **`app.set("trust proxy", 1)`** is load-bearing: without it every request behind
  Render's proxy looks like it came from the same address and the login rate
  limiter becomes one global bucket.
- The seeded promo is a **draft** on purpose — the site's `promo.js` is
  placeholder copy for a campaign that does not exist, and publishing it should
  be a deliberate act.
