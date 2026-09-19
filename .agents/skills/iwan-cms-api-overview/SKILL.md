---
name: iwan-cms-api-overview
description: Orientation for iwan-cms-api — layout, the two hosts, and which other skill to load. Load this when new to the repo or unsure which skill covers a change.
---

# iwan-cms-api overview

`README.md` is the full technical reference — every route, every model, every
gotcha with its reasoning. This skill is the map, not a copy of it.

## What this is

The CMS API behind `iwan.community`. Express + Mongoose on MongoDB Atlas.
Public, read-only routes (only `published` docs); `/api/admin`, behind a
sign-in. Two sibling repos complete the system:
`iwan-cms-admin` (the editor UI) and `new-iwan` (the public site + its
Cloudflare Worker + the email templates).

## Layout, briefly

```
src/config.js       every env var — see environment-and-secrets skill
src/app.js          route mounting, order matters — see deploying skill
src/models/         Event · Blog · Podcast · Promo · Audience · Application ·
                     ApplyForm · Registration · User
src/routes/
  crud.js            the shared list/create/update/delete router the four
                      content types are built from — a fifth type is a model,
                      a schema, a serialiser, one line in admin.js
  register.js, forms.js   event registration, subscribe/contact/volunteer/career
  webhooks.js, unsubscribe.js   see resend-email-system skill
src/lib/
  mail.js, contacts.js, segments.js, templates.js, welcome.js, background.js
                      the Resend system — see resend-email-system skill
  audience.js          recordAudience() — the ONE way into the audience list
  tokens.js             session JWTs AND signed unsubscribe tokens, kept apart
                      by a `purpose` claim
```

## Content model, in one line

Four types share one CRUD pattern; every doc carries `countries: [String]`
where **empty means every country**; dates are `"YYYY-MM-DD"` strings, never
`Date` objects — see `README.md`'s "Gotchas worth knowing" for why each of
these is true.

## Other skills in this deck

| skill | load it for |
|---|---|
| `environment-and-secrets` | any env var, or the sops-encrypted `.env` |
| `resend-email-system` | anything under `src/lib/emails/`, `contacts.js`, `segments.js`, `templates.js`, `welcome.js`, `mail.js`, `routes/webhooks.js`, `routes/unsubscribe.js` |
| `local-development` | running this + the site locally, testing forms/email |
| `deploying` | Vercel/Render specifics, `CMS_FORWARD_SECRET` |

## Before calling a change done

`npm run smoke` and `npm run format:check`. If it touches an env var, `.env.example`
and the `environment-and-secrets` skill both need to still agree with `config.js`.
