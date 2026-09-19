---
name: resend-email-system
description: Contacts, segments, templates, the four message types, unsubscribe, and the inbound webhook. Load before touching src/lib/emails/, contacts.js, segments.js, templates.js, welcome.js, mail.js, routes/webhooks.js, or routes/unsubscribe.js.
---

# The Resend email system

The largest feature in this codebase, with several real production bugs
already found and fixed here — read the ⚠ items before changing anything in
this path, so a fix doesn't reintroduce one.

## The shape of it

```
form submitted → recordAudience() → mirrorContact()   EVERYONE, subscribed or not
                                   → segmentsFor()      3 automatic segments
              → welcome()          ONLY if subscribed, ONCE per country
              → send*Confirmation() unconditional, every submission

each send: resolveTemplate() → published Resend Template, or null
             found → Resend renders it
             null  → render() renders the SAME .html from templates/

unsubscribe link/CMS toggle/Resend webhook → all three flip `subscribed` and
                                              re-mirror to Resend
```

## ⚠ Fire-and-forget does not work on Vercel

A Vercel function freezes the instant it responds — any un-`await`ed promise
at that moment is abandoned, not slow. `lib/background.js` is the fix and the
**only** correct way to run side-effect work here: `await background(...)`
**before** the response, every time. A new call site that fires something off
after `res.json()` reintroduces a real incident (confirmations sent, Resend
contact never created).

## ⚠ Contacts: everyone is mirrored now, not just subscribers

Used to mirror only subscribers, which made `Event registrations` silently
incomplete. Now every `recordAudience()` call mirrors the person, with
Resend's `unsubscribed` flag as the inverse of `person.subscribed` — a
non-subscriber becomes a suppressed contact, not a missing one. **Mirrored is
not mailed** — `welcome()` still only sends to actual subscribers.

## ⚠ Segments: name-based, not id-based, and two races already fixed

Three automatic segments (`Iwan India`, `Iwan Canada`, `Event registrations`)
in `lib/segments.js`, created on first use. A duplicate-create race is fixed
by an in-flight lock + oldest-wins resolution; wrong-country filing is fixed
by passing every country a person has acted through, not just their first.

## ⚠ Templates: Resend's copy wins, same file is the fallback

`src/lib/emails/templates/*.html` — nine files, uploaded to Resend as
Templates (matched by **alias**, never id/name) and rendered locally by
`render.js` as the fallback when none is published. A published-but-empty
`unsubscribe_url` sent to Resend bakes in as a literal dead `href=""` —
Resend has no conditionals. `mail.js` guards this: the Resend template is
only even looked up when there is a real URL to give it; otherwise it falls
back to `render()`, which drops the row via `dropSection()`. Any new
URL-dependent section needs the same guard.

## ⚠ Welcome: once per subscription, per country — not once per person ever

`welcomeSubscriber()` claims before sending (`$ne` conditional update),
gives the claim back on a failed send, and treats each country as a separate
opt-in. A migration backfill handles rows stamped `welcomeSentAt` before
`welcomedCountries` existed, so they don't get re-welcomed.

## Testing without touching real Resend

```bash
npm run mail:preview                          # renders locally, no key
npm run mail:preview -- --to=you@example.com  # sends for real
npm run webhook:ping                          # signs + posts a fake event locally
npm run sync:contacts -- --dry                # reports what a backfill would do
```

`npm run smoke` never touches Resend — `RESEND_API_KEY` is blanked for the
whole run.
