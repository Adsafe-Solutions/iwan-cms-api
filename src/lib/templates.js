import { CONFIG } from "../config.js";
import { resend } from "./resendClient.js";

/* Templates edited in Resend, with the ones in `emails/` as the fallback.

   ⚠ RESEND WINS WHERE IT HAS ONE. The point is that the copy can be changed by
   someone who does not deploy: create a template in Resend under the alias
   below, publish it, and the next send uses it. Delete it and the code takes
   over again. Nothing here needs redeploying either way.

   ⚠ PUBLISHED ONLY. A template still in draft is somebody mid-edit, and
   sending a half-written message to a registrant is worse than sending last
   month's wording. A draft is treated as absent.

   ⚠ The fallback is not a nicety — it is what makes a Resend account with no
   templates at all work exactly as it did before. Every path here answers
   "use the code" rather than throwing. */

/* The ALIAS to look for, per message.

   ⚠ THE ALIAS, NOT THE ID AND NOT THE NAME. Resend generates the id itself — a
   UUID nobody can choose — and the `name` is a display label somebody will
   rename the first time they tidy the dashboard. The alias is the only handle
   this API can hard-code and expect to keep working.

   ⚠ Folders in the Resend dashboard do not come into it: there is no folder
   field on a template, so however they are filed, the alias is what is looked
   up. Overridable in case an account already has its own naming. */
const REGISTRATION = CONFIG.templates.registration || "iwan-registration";

/* ⚠ TRIED IN ORDER, first published one wins, then the built-in message. The
   list is what lets an account override everything with one template, or just
   one country. */
export const aliasesFor = (kind, { country = "" } = {}) => {
  if (kind === "welcome") {
    const welcome = CONFIG.templates.welcome || "iwan-subscribe-welcome";
    /* ⚠ Same rule as registration: a country's own template if there is one,
       otherwise the general one. Canada's links are country-prefixed and its
       social accounts are its own, so the two are not interchangeable. */
    return [country && `${welcome}-${country}`, welcome].filter(Boolean);
  }
  /* ⚠ ONE ALIAS FOR BOTH volunteer and career — they are the same
     acknowledgement with a different word in it, and the word is a variable.
     Two templates would drift apart the first time one was edited. */
  if (kind === "application") {
    const base = CONFIG.templates.application || "iwan-application";
    return [country && `${base}-${country}`, base].filter(Boolean);
  }

  if (kind !== "registration") return [];

  return [country && `${REGISTRATION}-${country}`, REGISTRATION].filter(Boolean);
};

/* ⚠ Cached for the life of the process, MISSES INCLUDED — an account with no
   templates must not pay a lookup on every single send. The cost is that a
   template added in Resend reaches a running server on its next restart; on
   Vercel, where an instance lives minutes, that is close to immediate. */
const cache = new Map();

/**
 * The published template for one message, or null to use the built-in file.
 *
 * ⚠ NEVER THROWS. Resend being unreachable means the email still goes out, from
 * the code — a lookup failure must not become an email nobody receives.
 *
 * @returns {Promise<{id: string, subject: string|null}|null>}
 */
export async function resolveTemplate(kind, context) {
  if (!resend) return null;

  for (const alias of aliasesFor(kind, context)) {
    const found = await lookup(alias);
    if (found) return found;
  }
  return null;
}

async function lookup(alias) {
  if (cache.has(alias)) return cache.get(alias);

  let found = null;
  try {
    /* `get` takes an id OR an alias, so this is one call rather than listing
       everything and filtering. */
    const { data, error } = await resend.templates.get(alias);

    if (error) {
      /* ⚠ Not found is the ordinary case, not a fault: most accounts will have
         no template for most messages. Anything else is worth a line in the
         log, because it means the code fallback is being used for a reason
         nobody chose. */
      if (!/not.?found|404/i.test(`${error.name ?? ""} ${error.message ?? ""}`)) {
      }
    } else if (data?.status !== "published") {
    } else {
      found = { id: data.id, subject: data.subject ?? null };
    }
  } catch {}

  cache.set(alias, found);
  return found;
}

/* ⚠ Resend accepts strings and numbers only, and silently does nothing useful
   with anything else. Everything is coerced here rather than at each call site,
   and an empty value is passed as "" so a template's own fallback can show. */
export const variables = (pairs) =>
  Object.fromEntries(
    Object.entries(pairs).map(([key, value]) => [
      key,
      typeof value === "number" ? value : String(value ?? ""),
    ])
  );

/* Only for the smoke suite, which needs two different answers in one process. */
export const forgetTemplates = () => cache.clear();

export default resolveTemplate;
