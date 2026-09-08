/* ⚠ The BUNDLE, not the package — see scripts/vendor-sanitizer.mjs. Same
   sanitize-html, with htmlparser2 inlined at build time, because Vercel's
   function runtime disables Node's require(esm) and the package cannot load
   there otherwise. Behaviour is unchanged; only the import path is. */
import sanitizeHtml from "./vendor/sanitize-html.mjs";

/* Posts are stored as HTML and rendered with `dangerouslySetInnerHTML`.

   ⚠ Sanitising is therefore a SECURITY control, and it happens HERE — on write,
   before storage — so the stored value is trustworthy for every consumer and
   there is one place to get it right. It runs on every write path including
   PATCH and the seed: "an editor would not paste a script tag" is not a
   security model when Word paste and compromised accounts look the same. */

/* An allowlist: anything not named here is dropped. ⚠ No `h1` — the page
   supplies the post's title as the h1 and a second breaks the outline. No
   `span`, `div` or `style` either: the usual vehicle for pasted Word junk. */
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
  /* ⚠ What blocks `javascript:` URLs — script execution dressed as a link, and
     the likeliest way through an otherwise sensible allowlist. */
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesAppliedToAttributes: ["href", "src"],
  /* A protocol-relative `//evil.com` is not obviously a scheme. */
  allowProtocolRelative: false,
  /* ⚠ Discard the CONTENT, not just the tags — dropping `<script>` while
     keeping the code inside leaves the payload in the page as text. */
  nonTextTags: ["style", "script", "textarea", "option", "noscript"],
  transformTags: {
    /* Applied here rather than trusted from the editor, so a link pasted as
       raw HTML cannot reach back through `window.opener`. */
    a: sanitizeHtml.simpleTransform("a", {
      target: "_blank",
      rel: "noopener noreferrer",
    }),
    /* Always below the fold of the post's own hero. */
    img: sanitizeHtml.simpleTransform("img", { loading: "lazy" }),
  },
};

export const sanitize = (html = "") => {
  if (typeof html !== "string" || html.trim() === "") return "";
  return sanitizeHtml(html, SANITIZE_OPTIONS).trim();
};

/* An empty editor produces the markup for one empty paragraph, not "". Without
   this, every half-written post has a technically non-empty body. */
const EMPTY = /^(<p>(\s|&nbsp;|<br\s*\/?>)*<\/p>\s*)+$/i;

export const isEmptyHtml = (html = "") => !html.trim() || EMPTY.test(html.trim());

const escape = (text = "") =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/* Blocks → HTML, used once per post by the migration and the seed. ⚠ The
   reverse (`htmlToBlocks`) is gone — it was a shim, and carrying both formats
   was 45% of /api/content for no reader. Consecutive `li` blocks become one
   list, which the pair format had no way to express. */
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
    /* ⚠ "h" becomes h2, never h1 — see ALLOWED_TAGS. */
    out.push(kind === "h" ? `<h2>${escape(text)}</h2>` : `<p>${escape(text)}</p>`);
  }

  closeList();
  return out.join("\n");
}
