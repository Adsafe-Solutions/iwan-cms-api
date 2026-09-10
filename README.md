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

## Editing the emails in Resend

**The designed templates live in Resend** — the same files the site repo keeps
in `emails/`, uploaded there. This API looks one up on every send and uses it
when it finds one; `src/lib/emails/` is the fallback for when it does not.

⚠ **It is matched on the template's ALIAS.** Resend generates the `id` itself (a
UUID nobody can choose) and the `name` is a display label somebody will rename
the first time they tidy up — the alias is the only handle worth hard-coding.
Folders in the dashboard make no difference: a template has no folder field, so
file them however you like as long as the alias matches.

⚠ **Tried in order, the first published one wins**, so an account can override
everything with one template or just one country:

| template id                       | for                                             |
| --------------------------------- | ----------------------------------------------- |
| `iwan-registration-{in\|ca}`      | that country                                    |
| `iwan-registration`               | any registration                                |
| `iwan-subscribe-welcome-{in\|ca}` | that country's welcome                          |
| `iwan-subscribe-welcome`          | any welcome                                     |
| `iwan-application-{in\|ca}`       | that country's volunteer/career acknowledgement |
| `iwan-application`                | any application                                 |

### ⚠ The variable names are NOT the tokens in the HTML file

Resend **reserves** `FIRST_NAME`, `LAST_NAME`, `EMAIL`, `UNSUBSCRIBE_URL`,
`contact` and `this`, and refuses them as custom variables. So a template
uploaded to Resend must use the **lower-case** names, which are what this API
sends:

```
registration   first_name · event_title · event_date · event_start · event_end
               event_venue · event_url · event_image · directions_url
               unsubscribe_url
welcome        first_name · site_url · unsubscribe_url
application    first_name · application_type · role · site_url
```

⚠ **Declare every one on the template, each with a fallback.** Resend's syntax is
`{{{triple_braces}}}`, and a variable that is neither declared nor given a
fallback makes the send **fail** with a validation error rather than rendering
blank.

⚠ **Do not use `{{{RESEND_UNSUBSCRIBE_URL}}}`** in these. Resend substitutes it
for Broadcasts only; in a transactional send it ships as literal text beside a
dead link. `unsubscribe_url` carries this API's own signed link, which works.

⚠ **`directions_url`** is built the way the site's `lib/map.js` builds it —
coordinates where the event has them, the venue text otherwise — so the email
and the page pin the same place.

⚠ **Published only.** A draft is somebody mid-edit, and half-written copy
reaching a registrant is worse than last month's wording, so a draft is treated
as absent. ⚠ **Delete the template and the code takes over again** on the next
instance.

### The built-in message is a fallback, not a second design

`src/lib/emails/registration.js` renders a plainer confirmation, and only when
Resend has no published template or cannot be reached. ⚠ **It is deliberately
NOT a copy of the designed file.** Two copies of the same 40KB layout in two
repos drift, and the stale one is the one that sends. ⚠ **Both paths build their
values in ONE place** — `registrationValues` in that same file — so the fallback
and the Resend template always get the same facts under the same names.

⚠ **The subject comes from the template**, and the code's subject is used only
when the template has none — passing one always would override what was written
in Resend.

⚠ **The lookup is cached for the life of the process, misses included**, so an
account with no templates does not pay a lookup on every send. A template added
in Resend reaches a running server on its next restart; on Vercel, where an
instance lives minutes, that is close to immediate. A lookup that fails means
the code is used — Resend being unreachable must never become an email nobody
receives.

⚠ **Only the two above.** The notifications to Iwan's own inbox are internal and
always come from the code.

## Subscribing

Ticking a newsletter box — in the site footer, or on an event registration,
contact, volunteer or career form — does three things: the person joins the
`audience` collection, they are pushed to Resend as a contact, and they get one
welcome email.

⚠ **The welcome is sent ONCE, EVER**, per `welcomeSentAt` on the audience row.
Somebody who subscribes, unsubscribes and subscribes again is not greeted twice,
and somebody who ticks the box on a registration form having subscribed last
year is not greeted at all. It is a _separate_ message from the booking
confirmation, because they say different things and only one of them is
marketing.

⚠ **The stamp is CLAIMED before the send, not written after.** Two submissions
landing together would otherwise both read "not sent yet" and both send. ⚠ **A
failed send gives it back**, or one Resend outage would mean that person is
never greeted at all — the row would claim it had been done.

⚠ **The welcome is refused without an unsubscribe link.** It is the one message
here that is marketing rather than transactional, and a marketing email with no
way off the list is what gets a sending domain blocked. No `API_URL` means no
link, which means no welcome — see the unsubscribe section.

`POST /api/subscribe` answers `{ ok: true, alreadySubscribed: boolean }`, so the
site can say _"you are already on the list"_ rather than a second _"thank you for
subscribing"_. ⚠ **That is the one form here that says anything back**, and it is
a deliberate trade: it tells whoever posted the form whether that address is
already subscribed, so an address can be tested. The site's own form is worth
it; treat the flag as public.

## ⚠ Work after the response, and Vercel

**Fire-and-forget does not work on Vercel.** A serverless function is frozen the
moment its response is sent, so a promise nobody is waiting on is abandoned
part-way — the sign-up is stored, the 201 goes out, and the confirmation email
is never sent. Nothing errors and nothing is logged, which is what makes it so
hard to see. On a normal always-on server the same promise finishes perfectly
well, and waiting for it would only make every form slower.

`lib/background.js` is the one place that difference is expressed, the same way
`storage.js` already branches on `VERCEL` for the upload limit. Everything that
used to be started and abandoned now goes through it:

```js
await notify({ … });            // Iwan's heads-up
await welcome(person);          // the subscriber's welcome
await mirrorContact({ … });     // the push to Resend
await background("registration confirmation", async () => { … });
```

⚠ **Always awaited, and always BEFORE the response.** Off Vercel these return
immediately and the work finishes behind the response exactly as it used to; on
Vercel awaiting is the only thing keeping the function alive long enough for the
work to happen. ⚠ **None of it can fail a form** — every one of these swallows
its own errors, so an outage delays a response slightly rather than turning a
booked place into an error the person retries.

## The Resend audience

Everyone who **subscribes** is mirrored into Resend as a contact, so a
newsletter can be written in Resend's own composer instead of exporting a CSV
before every send.

⚠ **The `audience` collection stays the record of truth.** It holds the
messages, the sources, the notes and everyone who filled in a form without
ticking the box. Resend gets only the subset that agreed to be mailed.

⚠ **The push happens in `recordAudience`, not in the subscribe route** — that
is the one way a person reaches the audience list, and five forms can tick the
newsletter box. Wiring it to `/api/subscribe` would mirror the newsletter box
and silently miss the other four.

⚠ **Only `subscribed` rows are mirrored**, and the stored row's own flag is what
is read, not the flag on the request. Someone who sent a contact message without
opting in is in Iwan's audience and is not a Resend contact.

⚠ **It rides on `RESEND_API_KEY`.** No key means no sync, exactly as it means no
mail, and every form works unchanged. `RESEND_SEGMENT_ID` is optional — it is
the list a broadcast goes to; without it contacts still land on the account,
just ungrouped.

### Properties, not tags

Resend contacts have **no tags field** — `properties` is the equivalent, and
`lib/contacts.js` writes the same four on every contact: `source` (which form
brought them in), `country`, `joined` (a day string), and `managed_by:
iwan-cms`, which is what tells a mirrored contact apart from one added by hand
in the dashboard. `source` records where somebody **first** arrived, not the
form they last touched — it is paired with `joined`, and a value that moved
around would make anything built on it meaningless.

⚠ **A property must exist on the account before a contact can carry it, and
Resend refuses the WHOLE CONTACT when it does not** — not the property, the
contact. So `ensureProperties` creates any that are missing, once per process,
on the first sync rather than at boot: a deployment that never takes a
subscriber should not spend a round trip on every cold start proving something
it will not use. **There is nothing to set up in the dashboard.** A property
deleted there reappears on the next sync.

If they cannot be ensured at all — Resend down, a key without permission — the
contact is synced **untagged** rather than not at all, and the log says so. A
person on the list who cannot be segmented is worth having; a person missing
from it is not.

### Segments are lists, not rules

⚠ **`RESEND_SEGMENT_ID` is ONE optional id, and it is not per source.** A Resend
segment is a static list — creating one takes a name and nothing else, with no
filter or condition — so there is no "everyone whose `source` is event" segment
that keeps itself up to date. Everyone mirrored goes into the one segment named
here, and the `source` property is what distinguishes them inside it. With no
segment set they are still contacts on the account, just ungrouped.

Wanting a genuinely separate list per form is a change to `lib/contacts.js`, not
a configuration: it would need a segment id per source and a map from one to the
other. Worth doing the day a broadcast needs to reach volunteers without
reaching everybody, and not before.

⚠ **Resend's flag is the NEGATIVE of ours** — `unsubscribed`, not `subscribed`.
It is inverted in both directions, in `lib/contacts.js` on the way out and in
`routes/webhooks.js` on the way in. Getting it backwards mails everyone who
opted out.

Nothing is awaited. A sync that fails is logged and the form still answers 201 —
the subscription is stored either way, and a Resend outage must never turn a
filled-in form into an error the person retries.

### Unsubscribing

⚠ **Resend does this for BROADCASTS and does none of it for the mail this API
sends.** Its hosted flow — the `{{{RESEND_UNSUBSCRIBE_URL}}}` variable, the
customisable page, the contact update — applies to Broadcasts and Automations
only; their own words are _"Resend doesn't manage contact lists for
transactional emails"_. So a newsletter sent from Resend already unsubscribes
people properly and the webhook above syncs it back, and the confirmation email
this API sends needs its own, which is `routes/unsubscribe.js`.

It does the same three things Resend's page does: records it, says so, and
tells the other side.

- `GET /api/unsubscribe?t=…` — the link in the email. Unsubscribes, then renders
  the one HTML page this API serves.
- `POST /api/unsubscribe?t=…` — RFC 8058 one-click. Gmail and Apple Mail show
  their **own** unsubscribe button beside the sender name and post here when it
  is pressed, without the person ever seeing a page. ⚠ It answers an empty
  `200`, always — a redirect, a body, or a 4xx all read as a failed unsubscribe
  to the provider, and a 4xx teaches it that this sender's button is broken.

⚠ **A signed token, never the address.** `?email=…` would let anyone
unsubscribe anyone by typing an address, and every such link leaks a real
address into logs and referrers. The token carries a `purpose` claim, so a
session token signed with the same `JWT_SECRET` cannot be spent here.

⚠ **It never expires.** People unsubscribe from the oldest mail in the pile, and
"this link has expired" is a link that failed at its only job — the recipient
does not try again, they press _spam_, which costs the domain far more than an
old token being valid.

⚠ **The visible footer link is for SUBSCRIBERS only; the header is on every
message.** The confirmation goes to everyone who registers, and most never
ticked the newsletter box — offering to unsubscribe them from something they
never joined invites the reply _"I never signed up for this"_. The
`List-Unsubscribe` header stays regardless: it costs the reader nothing, mailbox
providers read its presence as a sender behaving properly, and pressing Gmail's
button still does the right thing.

⚠ **It needs `API_URL`.** With none set there is no honest way for the process
to know its own public address, so the footer link and both headers are dropped
rather than pointing at localhost.

⚠ **It writes to Resend too.** Unsubscribing here and not there means the next
broadcast still reaches them — the mirror image of what the webhook does in the
other direction.

The page says plainly what has **not** stopped: unsubscribing from the
newsletter does not cancel a place at an event. It fetches nothing — no script,
no image, no stylesheet — and carries its own tight CSP, because the app-wide
one is off on the grounds that this API served no HTML until this route existed.

### The webhook

`POST /api/webhooks/resend` is the only inbound path, and the reason the two
lists do not drift. Point a webhook in the Resend dashboard at it, subscribed to
`contact.created`, `contact.updated`, `contact.deleted` and `email.complained`,
and put its `whsec_…` signing secret in `RESEND_WEBHOOK_SECRET`.

⚠ **This is what carries an unsubscribe back.** Someone clicking the link at the
bottom of a broadcast is recorded by Resend, not here; without the webhook Iwan
goes on believing they are subscribed and mails them again next month.

⚠ **It is mounted BEFORE `express.json()` in `app.js` and cannot move below it.**
The signature covers the exact bytes Resend sent, and parsing the JSON then
re-encoding it changes key order and whitespace, so every verification fails.
The router parses its own raw body; a smoke check posts malformed JSON to prove
nothing upstream got there first.

⚠ **Nothing here creates a person.** Every write is an `updateOne` with no
upsert, so an event for an address Iwan has never seen changes nothing — a
leaked signing secret must not become an unauthenticated write to the audience.

⚠ **A complaint unsubscribes; a bounce only logs.** A spam report is stronger
than an unsubscribe and carrying on is how a sending domain gets blocked. A
bounce is not consent withdrawn — a full mailbox, a bad afternoon and a dead
address all arrive as the same event, and acting on the first would drop people
who are still reading. Recording delivery state per person wants a field of its
own the day that matters.

### Setting it up

In the Resend dashboard, once:

1. **Create a webhook** pointing at `https://YOUR-API-HOST/api/webhooks/resend`,
   subscribed to `contact.created`, `contact.updated`, `contact.deleted` and
   `email.complained`. ⚠ Those four are exactly what `routes/webhooks.js` acts
   on — subscribing to fewer silently drops an unsubscribe, and to more delivers
   events nothing reads.
2. **Copy its signing secret** into the deployment's environment as
   `RESEND_WEBHOOK_SECRET`, and set `API_URL` to the API's own public address.
3. Optionally **create a segment** for subscribers and set `RESEND_SEGMENT_ID`
   to its id. Without one they are still contacts, just ungrouped.

⚠ **The service has to restart to read them.** Until it does, the webhook
endpoint answers 503 — which Resend retries, so nothing is lost meanwhile.

There is nothing else to set up: the four contact properties are created by the
API itself on the first sync, not by hand.

Then, if there are already subscribers in the database:

```bash
npm run sync:contacts -- --dry     # check, then run it for real
npm run sync:contacts
```

`sync:contacts` is the one-off that carries the audience **already in the
database** up to Resend. Without it the live sync only fires when somebody
submits a form, so an existing list would cross over one person at a time as
they happen to come back — which for most of a list is never. It syncs only
people who are `subscribed` (`--all` also pushes the rest as _unsubscribed_,
which is a suppression record rather than a mailing list), paces itself at five
requests a second to leave half of Resend's ten-per-second budget for the live
site, and is safe to re-run or interrupt: every write is an upsert keyed on the
address, and nothing is ever deleted. Failures are named at the end rather than
counted, and re-running retries them. ⚠ It needs a Resend key and the database
in the same process, so it runs from a machine that has both — it cannot run
itself on the deployment.

### Testing it without deploying

`npm run webhook:ping` signs an event exactly as Resend does and posts it to
your own API — **no tunnel, no Resend account, no deployment**. A signature is
HMAC arithmetic over the bytes, so anything holding the same
`RESEND_WEBHOOK_SECRET` can produce one, which is the whole reason that secret
is a secret.

```bash
# Any long random value works locally; it only has to MATCH on both sides.
echo "RESEND_WEBHOOK_SECRET=whsec_$(head -c 24 /dev/urandom | base64)" >> .env

npm run dev:memory                                     # or npm run dev
npm run webhook:ping -- --email=you@example.com        # an unsubscribe
npm run webhook:ping -- --email=you@example.com --resubscribe
npm run webhook:ping -- --type=email.complained --email=you@example.com
npm run webhook:ping -- --forged                       # watch it refused: 400
```

⚠ **The person has to already be in the audience.** Nothing here creates one, so
subscribe on the site (or `POST /api/subscribe`) first, then ping — otherwise
the route answers 200 having matched nobody, which is correct and looks like
nothing happened.

The failures are worth firing on purpose. `--forged` proves the refusal;
changing the secret on one side only proves the same thing the other way; and a
`503` means the API has no secret and needs the variable **and a restart**.

What this does NOT prove is the Resend end — that the dashboard webhook is
pointed at the right URL and subscribed to the right events. For that the API
has to be reachable from the internet, so put a tunnel in front of it and use
that hostname as the endpoint:

```bash
cloudflared tunnel --url http://localhost:4000    # no account needed
# or: ngrok http 4000
```

Then create the webhook in Resend against `https://…/api/webhooks/resend`, paste
**its** signing secret into `.env`, restart, and use the dashboard's own send-test
button. ⚠ The tunnel hostname changes every time it restarts, and the webhook in
Resend does not follow it.

Status codes are deliberate: **503** with no secret configured (Resend retries,
so nothing is lost while it is being set up), **400** on a signature that does
not verify (a 4xx stops the retries — it will not verify on the fifth attempt
either), **200** for anything understood including events deliberately ignored,
and **500** only when a database write failed, which is the one case worth
being sent again.

⚠ **The sync is not covered end-to-end by `npm run smoke`.** The suite empties
`RESEND_API_KEY`, so what it proves is that every form works with the sync off
and that the webhook refuses what it should. The push itself is checked by hand
against a real key — subscribe on the site, then look for the contact and its
`source` property in the dashboard.

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

⚠ **The sanitizer is imported from a COMMITTED BUNDLE**, not from
`node_modules` — `src/lib/vendor/sanitize-html.mjs`, built by
`npm run vendor:sanitizer`. Vercel's function runtime launches node with
`--no-experimental-require-module` in `process.execArgv`, which disables
`require(esm)` and overrides `NODE_OPTIONS`; `sanitize-html` is CommonJS and
requires the ESM-only `htmlparser2`, so it cannot load there at all — every
route dies at module load, including ones that sanitise nothing. Bundling
resolves that import at build time. Rolling the dependency back instead would
have reintroduced a `javascript:` bypass or GHSA-jxwj-j7wr-gfrw, and pinning
htmlparser2 back to 10.x breaks the RCDATA decoding 2.17.7 assumes — both
measured, not guessed. ⚠ **Re-run `npm run vendor:sanitizer` whenever
sanitize-html is upgraded**; the smoke suite fails if the two drift.

⚠ **Node 22.12 or newer, and the floor is not ours.** `sanitize-html` is
CommonJS and `require()`s `htmlparser2`, which is ESM-only — a combination that
only runs from Node 22.12, where `require(esm)` landed. Its own package.json
says `engines: >=22.12`. An older Node throws while the module loads, before
any route runs, so EVERY path fails identically. Vercel's Node version is a
project setting, not a repo one: Settings → Node.js Version → 24.x.

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
- **The webhook's raw body survives**, because the request stream is handed
  straight to Express and `routes/webhooks.js` reads it itself. ⚠ Anything that
  reads `req.body` on the platform's own request object before Express sees it
  consumes that stream, and Resend signatures stop verifying with no other
  symptom.
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
    webhooks.js      Resend calling us — raw body, signature checked
    admin.js         everything behind a sign-in
    crud.js          the shared list/create/update/delete router
    auth.js          sign in, /me, change password
  lib/               countries · serialize · errors · tokens · contacts
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
