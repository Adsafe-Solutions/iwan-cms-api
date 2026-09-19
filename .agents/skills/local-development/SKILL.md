---
name: local-development
description: Running iwan-cms-api and the site together locally, without touching production. Load for setup, "form isn't going through" locally, or testing email/webhooks.
---

# Local development

## ⚠ Node version

`engines: "24.x"`. Wrong Node has already caused `sharp`'s native binary to
fail installing, and Vite in `new-iwan` to refuse starting entirely
(`crypto.hash is not a function` — needs 20.19+/22.12+). Check
`node --version` before troubleshooting anything else.

## Running the API

```bash
npm run dev          # against the REAL MongoDB — see README's one-database warning
npm run dev:memory   # throwaway in-memory DB instead
```

`dev:memory` also creates+**activates** the volunteer/career apply-forms
(they ship inactive by design) and one demo event — without this there is
nothing to register for on a fresh database.

## Running the site against it

```bash
cd iwan-cms-api && npm run dev:memory                              # :4000
cd new-iwan && VITE_CMS_API_URL=http://localhost:4000 npm run dev  # :5173
```

`new-iwan`'s Vite config proxies `/api/*` to `DEV_API_PROXY` (default
`http://localhost:4000`) — without it every form 404s against the SPA
fallback, since plain `vite dev` has no Cloudflare Worker to forward through.
⚠ This proxy skips Turnstile entirely; use `npm run preview:cf` in that repo
when Turnstile itself needs testing.

## Testing email/webhooks with no tunnel, no real Resend account

```bash
npm run mail:preview                          # local HTML files
npm run mail:preview -- --to=you@example.com  # sends for real
npm run webhook:ping                          # signs + posts a fake Resend event
npm run sync:contacts -- --dry                # dry-run the backfill
```

See the `resend-email-system` skill for what each of these actually proves.

## Curl-testing forms directly

```bash
curl -X POST "localhost:4000/api/events/demo-event/register?country=in" \
  -H 'content-type: application/json' \
  -d '{"answers":{"name":{"first":"Aisha","last":"Rahman"},"email":"you@example.com"},"subscribe":true}'
```

Same shape for `/api/contact`, `/api/volunteer`, `/api/career` (the latter
two need `mobile`, `about`, `consent`). Swap `country=in` for `ca` to check
the Canadian templates/segment.
