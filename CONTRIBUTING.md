# Contributing to iwan-cms-api

Start here if you are new to this repo — this is the "get set up and know
where everything lives" doc. It is deliberately **not** a copy of
`README.md`, which is the technical reference for how this API actually
works; this one is about getting from a fresh clone to a working local stack,
and knowing which document to open next for whatever you are about to do.

## The three repos this system is made of

This API is one third of a system that only makes sense together. Nobody
works in just one of these for long:

| repo | what it is | where |
|---|---|---|
| **`iwan-cms-api`** | **this one** — the Express + Mongoose API | you are here |
| `iwan-cms-admin` | the React admin UI editors actually use | sibling directory |
| `new-iwan` | the public marketing site, its Cloudflare Worker, and the designed email templates | separate checkout |

A change to this API's public routes usually needs a matching change on the
site; a change to `/api/admin` usually needs one in the admin UI. Check
whether the thing you are changing has a counterpart on the other side before
assuming a one-repo change is complete.

## Before you start

- **Node 24.x** — `package.json`'s `engines` field means this, not a
  suggestion. A wrong Node version has already caused real, confusing
  failures in this project (a native dependency's binary silently missing, a
  dev tool refusing to start with an error that names neither the tool nor
  the real problem). Check `node --version` before troubleshooting anything
  else.
- **A PGP key loaded** if you need to read or edit real secrets — this repo's
  `.env` is committed to git, **encrypted** with
  [sops](https://github.com/getsops/sops). You do not need this for most
  work: `npm run dev:memory` (below) needs no real secrets at all. See the
  `environment-and-secrets` skill (below) before touching `.env` for real.
- **`gh` (GitHub CLI)** if you will be opening pull requests from the command
  line — not required, just convenient.

## First-time setup

```bash
git clone <this repo>
cd iwan-cms-api
nvm use 24          # or however you manage Node versions — see above
npm install

npm run dev:memory  # boots against a throwaway in-memory database, no
                     # real secrets, no real MongoDB — prints a dev admin
                     # login in its own startup banner
```

That is enough to have a working API on `:4000` with a demo event, working
admin login, and both apply-forms (volunteer/career) already active — see the
`local-development` skill for exactly what `dev:memory` sets up and why each
piece exists.

To confirm everything is actually working:

```bash
npm run smoke        # ~220 checks, no real database, no real Resend account
npm run format:check
```

## Where the documentation actually lives

| doc | for | when to read it |
|---|---|---|
| `README.md` | the technical reference — every route, every model, the deploy story | understanding how something already works |
| `.env.example` | every environment variable, with what happens when each is unset | setting up a deployment, or debugging "it works locally but not on X" |
| `.agents/skills/*/SKILL.md` (mirrored at `.claude/skills/`) | focused, task-scoped deep dives — meant to be loaded one at a time for the specific thing you are doing, by a human or an AI agent | starting a specific piece of work — see the table below |

**The skill deck**, one line each:

| skill | load it when |
|---|---|
| `iwan-cms-api-overview` | you are new here, or unsure which other skill covers your change |
| `environment-and-secrets` | touching `.env`, `config.js`, or any deployment's environment variables |
| `resend-email-system` | touching anything under `src/lib/emails/`, `contacts.js`, `segments.js`, `templates.js`, `welcome.js`, `mail.js`, or the webhook/unsubscribe routes |
| `local-development` | setting up locally, or testing forms/email without touching production |
| `deploying` | deploying to Vercel or Render, or something behaves differently between the two |

## Before opening a pull request

- `npm run smoke` and `npm run format:check` both clean.
- If the change touches an environment variable: is it in `.env.example`? Is
  the matching skill file (`environment-and-secrets`) still accurate?
- If the change touches an email/Resend feature: does the relevant part of
  the `resend-email-system` skill still describe what actually happens?
  Several real production bugs are documented there specifically so they do
  not get reintroduced quietly — read the ⚠ sections for the area you are
  touching before assuming a change is safe.
- ⚠ **This repo has exactly one database, and it is the live one** — see
  `README.md`'s warning about `npm run seed`/`seed:reset`. Never run either
  against real data without a `mongodump` first.
