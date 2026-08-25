import sanitizeHtml from "sanitize-html";

/* Blog posts are written as rich text and stored as HTML, which the public site
   renders with `dangerouslySetInnerHTML`.

   ⚠ That makes sanitising a SECURITY control, not a tidiness one, and it
   happens HERE — on write, before anything is stored — rather than on render.
   Two reasons: the stored value is then trustworthy for every consumer (the
   site, a future feed, an email), and there is exactly one place to get it
   right. Sanitising only at render means every new consumer has to remember.

   It runs on every write path, including PATCH and the seed, because "an editor
   would not paste a script tag" is not a security model — a pasted Word
   document, a copied CMS block from another site, or a compromised editor
   account all arrive the same way. */

/* An allowlist, not a blocklist: anything not named here is dropped.

   ⚠ No `h1` — the page supplies the post's own title as the h1, and a second
   one breaks the document outline. The editor offers h2/h3/h4 for that reason.
   No `span`, `div` or `style` either: they carry no meaning the site renders
   and are the usual vehicle for pasted junk from Word and Google Docs. */
const ALLOWED_TAGS = [
  "p",
  "br",
  "hr",
  "h2",
  "h3",
  "h4",
  "strong",
  "em",
  "u",
  "s",
  "blockquote",
  "ul",
  "ol",
  "li",
  "a",
  "code",
  "pre",
  "img",
  "figure",
  "figcaption",
];

const SANITIZE_OPTIONS = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "title", "width", "height", "loading"],
  },
  /* http/https/mailto/tel only. This is what blocks `javascript:` URLs, which
     are script execution dressed up as a link and the single most likely way
     a script gets through an otherwise sensible allowlist. */
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesAppliedToAttributes: ["href", "src"],
  /* A protocol-relative `//evil.com` URL is not obviously a scheme and would
     otherwise pass. */
  allowProtocolRelative: false,
  /* Discard the CONTENT of anything script-like, not just its tags — dropping
     `<script>` while keeping the code inside it would leave the payload sitting
     in the page as text, and one careless renderer away from executing. */
  nonTextTags: ["style", "script", "textarea", "option", "noscript"],
  transformTags: {
    /* Every link opens away from the site and cannot reach back through
       `window.opener`. Applied here rather than trusted from the editor, so a
       link pasted as raw HTML gets it too. */
    a: sanitizeHtml.simpleTransform("a", {
      target: "_blank",
      rel: "noopener noreferrer",
    }),
    /* Images in a post are always below the fold of the post's own hero. */
    img: sanitizeHtml.simpleTransform("img", { loading: "lazy" }),
  },
};

export const sanitize = (html = "") => {
  if (typeof html !== "string" || html.trim() === "") return "";
  return sanitizeHtml(html, SANITIZE_OPTIONS).trim();
};

/* An empty rich-text editor does not produce an empty string — it produces the
   markup for one empty paragraph. Treating that as content would give every
   half-written post a body that is technically non-empty, so a post with
   nothing in it reports as having nothing in it. */
const EMPTY = /^(<p>(\s|&nbsp;|<br\s*\/?>)*<\/p>\s*)+$/i;

export const isEmptyHtml = (html = "") => !html.trim() || EMPTY.test(html.trim());

const escape = (text = "") =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/* ── the one remaining bridge ──────────────────────────────────────────── */

/* Blocks → HTML. Used once per post by the migration and by the seed, to turn
   the site's existing `[kind, text]` pairs into the HTML the editor now owns.

   ⚠ The reverse (`htmlToBlocks`) is gone. It was a shim so the public payload
   could keep serving the old pair format while the site still rendered it; the
   site reads `html` now, and carrying both was 45% of the /api/content
   response for no reader at all.
   Consecutive `li` blocks become one list rather than a run of single-item
   lists, which is what they were always meant to be — the pair format simply
   had no way to say so. */
export function blocksToHtml(blocks = []) {
  const out = [];
  let list = null;

  const closeList = () => {
    if (list) {
      out.push(`<ul>${list.join("")}</ul>`);
      list = null;
    }
  };

  for (const block of blocks) {
    const kind = block?.kind ?? block?.[0];
    const text = (block?.text ?? block?.[1] ?? "").trim();
    if (!text) continue;

    if (kind === "li") {
      list = list ?? [];
      list.push(`<li>${escape(text)}</li>`);
      continue;
    }

    closeList();
    /* ⚠ "h" becomes h2, never h1 — see the note on ALLOWED_TAGS. */
    out.push(kind === "h" ? `<h2>${escape(text)}</h2>` : `<p>${escape(text)}</p>`);
  }

  closeList();
  return out.join("\n");
}
