import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* Fills the designed templates in `templates/`.

   ⚠ THOSE FILES ARE THE SOURCE OF TRUTH, and they are the SAME files uploaded
   to Resend as Templates — one set of markup, rendered here when Resend has no
   published template and by Resend when it does. Edit them there and re-upload;
   there is no second copy anywhere.

   ⚠ IT IS NOT A TEMPLATE LANGUAGE AND MUST NOT BECOME ONE. Substitution and
   nothing else: no loops, no conditions, no expressions. Those belong in the
   code that builds the values, where they can be read and tested — and the same
   files are rendered by RESEND, which has no conditionals either, so anything
   cleverer here would render differently in the two places.

   ⚠ EVERY VALUE IS HTML-ESCAPED. First names, subjects and whole messages come
   off public forms and end up in an inbox. */

const HERE = dirname(fileURLToPath(import.meta.url));

export const escapeHtml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/* ⚠ Read once at module load, not per send. They are tens of kilobytes each and
   cannot change while the process runs; reading them per request would put a
   synchronous file read in the path of every form submission.

   ⚠ A MISSING FILE IS FATAL, and deliberately: the sync script may not have
   been run, and failing at boot is far better than every confirmation going out
   as an empty page. */
const cache = new Map();

export function loadTemplate(name) {
  if (!cache.has(name)) {
    cache.set(name, readFileSync(join(HERE, "templates", name), "utf8"));
  }
  return cache.get(name);
}

/* ⚠ Resend's own syntax — `{{{triple braces}}}`, lower-case names — because
   these files are uploaded to Resend unchanged. One set of tokens, rendered
   identically whether Resend sends it or this does. */
const TOKEN = /(,?[ \t])?\{\{\{([a-z0-9_]+)\}\}\}/g;

/**
 * @param {string} name a file in `templates/`
 * @param {Record<string, string>} values lower-case keys, matching the tokens
 */
export function render(name, values = {}) {
  return loadTemplate(name).replace(TOKEN, (_match, lead = "", token) => {
    const value = values[token];

    /* ⚠ An empty value takes a preceding ", " or " " with it: the greeting
       reads "Assalamu alaikum {{{first_name}}} 👋" and somebody without a name
       would otherwise get a double space, and elsewhere a dangling comma.
       ⚠ An UNKNOWN token is removed too. A literal {{{event_venue}}} in an inbox
       is worse than a missing line, and these files are edited in another repo —
       a token this API has never heard of can arrive with the next sync. */
    if (value === undefined || value === null || value === "") return "";
    return `${lead ?? ""}${escapeHtml(value)}`;
  });
}

/**
 * Removes one banner-marked section from a rendered template.
 *
 * ⚠ THE ONE THING THIS DOES BEYOND SUBSTITUTION, and only because Resend
 * Templates have no conditionals: the designed files show their unsubscribe row
 * unconditionally, which is right when there is a link and a DEAD LINK when
 * there is not. Rather than teach the renderer conditions — which Resend could
 * not honour anyway, so the two sides would diverge — this drops the row
 * outright in the one case that cannot be rendered.
 *
 * ⚠ It keys on the `<!-- ====== NAME ====== -->` banners the designed files
 * already use to separate their sections, and removes that comment plus the
 * single `<tr>` after it. A file that stops using those banners silently keeps
 * the row; the smoke suite asserts the removal, which is what catches that.
 */
export function dropSection(html, name) {
  const banner = new RegExp(
    `[ \\t]*<!--\\s*=+\\s*${name}\\s*=+[\\s\\S]*?-->\\s*<tr>[\\s\\S]*?</tr>\\n`,
    "i"
  );
  return html.replace(banner, "");
}

/* Values are built with UPPER_CASE keys throughout — that is what the Resend
   variable list is derived from — and the files use lower case. One place to
   convert, so the two can never disagree. */
export const lower = (values) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));

export default render;
