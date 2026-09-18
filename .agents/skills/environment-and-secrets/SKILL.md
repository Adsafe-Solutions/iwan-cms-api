---
name: environment-and-secrets
description: How .env is committed and encrypted in this repo, the pre-commit hook that protects it, and where the full variable list lives. Load this before touching .env, config.js, or any deployment's environment variables.
---

# Environment and secrets

`.env.example` is the full variable list, with what each one does — this
skill covers what `.env.example` cannot: how secrets actually work here.

## ⚠ `.env` is committed, encrypted — not the usual convention

`.gitignore` has the bare word `env` (no dot), which does **not** match a
file literally named `.env` — that is what lets `.env` be tracked and
committed, sops-encrypted, instead of passed around out of band.
`.env.local`/`.env.*.local` stay properly ignored as before.

If `.env` ever looks plaintext or un-ignored, something is wrong — check
`git show HEAD:.env | head -3`; a real sops file starts `{ "KEY": "ENC[...]"`.

## Decrypting and editing it

```bash
sops --decrypt --in-place .env      # now plain text
# ... edit ...
sops --encrypt --in-place .env      # BEFORE staging, always
```

Safer alternatives with no plaintext-on-disk window: `sops .env` (opens
`$EDITOR`, re-encrypts on save) or `sops exec-env .env 'npm run dev'` (runs
one command with real env vars, writes nothing). Needs a PGP **private** key
loaded (`gpg --list-secret-keys`) for one of `.sops.yaml`'s recipients —
having only the public key is not enough.

## The pre-commit hook

`.githooks/pre-commit` (wired by `npm install` via the `prepare` script)
refuses to commit a plaintext `.env` or `secrets.yaml` — runs
`sops filestatus` on either whenever staged, blocks the commit if the result
is not `{"encrypted":true}`. Ported from `new-iwan`, which had the same
mechanism protecting the same risk. If this hook is ever missing after a
fresh clone, `npm install` was skipped or `.githooks` didn't come through —
`git config core.hooksPath .githooks` fixes it by hand.

## ⚠ `API_URL` is the most confused variable here

It is **this API's own public address**, set only in this repo's
environment — not `new-iwan`'s `VITE_CMS_API_URL`, not the admin's
`VITE_API_URL`, not Resend's address. Its only job is letting this API build
links back to itself (the unsubscribe link, `List-Unsubscribe` headers).

## Before calling a change done

Re-run the completeness check if a var was added or removed:

```bash
comm -23 <(grep -oE "process\.env\.[A-Z0-9_]+" src/config.js | sed 's/process.env.//' | sort -u) \
         <(grep -oE "^[A-Z0-9_]+=" .env.example | tr -d '=' | sort -u)
```

Empty output means `.env.example` still matches `config.js` exactly.
