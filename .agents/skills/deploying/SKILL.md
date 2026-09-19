---
name: deploying
description: Vercel vs Render specifics — the two entrypoints, the vendored sanitizer, and the CMS_FORWARD_SECRET ordering trap with the site's Worker. Load when deploying or diagnosing a platform-specific difference.
---

# Deploying

## The two hosts

| | Vercel | Render |
|---|---|---|
| entrypoint | `api/index.js` | `src/server.js` |
| model | frozen the instant it responds — see `resend-email-system` skill's background.js note | always-on |
| region | `bom1`, pinned for the **database's** location (Mumbai), not the visitor | wherever provisioned |
| upload limit | 4MB | 10MB |

Neither entrypoint substitutes for the other — `server.js` opens a port and
`process.exit(1)`s on a config problem (a crashed function, every request, on
Vercel); `api/index.js` exports a handler `npm start` has nothing to call.

## ⚠ The vendored sanitizer

`src/lib/vendor/sanitize-html.mjs` is a committed, built bundle, not a normal
import. Vercel's runtime disables `require(esm)`, and `sanitize-html`
(CommonJS) `require()`s `htmlparser2` (ESM-only) — that combination cannot
load on Vercel at all without this. **Re-run `npm run vendor:sanitizer`**
whenever `sanitize-html` is upgraded, or the smoke suite fails on drift.
Needs Node 22.12+ specifically.

## ⚠ `CMS_FORWARD_SECRET` — set the Worker first, always

Shared with `new-iwan`'s Cloudflare Worker, which verifies Turnstile then
forwards with this in an `X-Forward-Secret` header; this API refuses public
writes without a match. **Set it on the Worker before this API** — the
reverse order 403s every public form on the live site the moment this API's
deploy goes live, until the Worker catches up. Unset on either side is safe;
half-set in the wrong order is the one state that breaks something live.

```bash
wrangler secret put CMS_FORWARD_SECRET   # on the Worker (new-iwan), FIRST
# then the same value in this API's Vercel/Render env
```

## After any deploy

`assertConfig()` only refuses to boot on the core vars — it does **not**
catch a missing `API_URL` or `RESEND_WEBHOOK_SECRET`, which fail silently
(a real incident: confirmations sent fine, welcome emails silently never
did, because `API_URL` was missing). Worth checking by hand: `API_URL` is
set on **Production** specifically in Vercel (not just Preview/Dev — this
has happened), and a real registration produces both an email and a visible
Resend contact.
