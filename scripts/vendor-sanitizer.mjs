/* Bundles sanitize-html — htmlparser2 and the rest of its tree inlined — into
   one ESM file that `src/lib/html.js` imports instead of the package.

     npm run vendor:sanitizer

   ⚠ WHY THIS EXISTS. `sanitize-html` is CommonJS and `require()`s
   `htmlparser2`, which is ESM-only from v11. Node supports that (`require(esm)`,
   v22.12+) — but VERCEL'S FUNCTION RUNTIME DISABLES IT: it launches node with
   `--no-experimental-require-module` in `process.execArgv`, which also
   overrides NODE_OPTIONS. Every route then fails at module load with
   ERR_REQUIRE_ESM, including ones that never sanitise anything.

   ⚠ The alternatives were worse, and both were measured rather than assumed:
   an older sanitize-html has a `javascript:` bypass (< 2.17.2) or the
   `</textarea/>` mutation-XSS of GHSA-jxwj-j7wr-gfrw (< 2.17.7), and pinning
   htmlparser2 back to 10.x breaks the RCDATA decoding that 2.17.7's escaping
   assumes. Bundling changes no behaviour: esbuild resolves the import at build
   time, so nothing calls require() at runtime.

   The output is COMMITTED. It has to exist before `npm start`, and a build
   step that must run first on three different hosts is a thing to get wrong;
   the smoke suite fails loudly if it drifts from the installed version. */
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "src/lib/vendor/sanitize-html.mjs");

const { version } = JSON.parse(
  await readFile(path.join(root, "node_modules/sanitize-html/package.json"), "utf8")
);

await build({
  stdin: {
    contents: `export { default } from "sanitize-html";`,
    resolveDir: root,
    sourcefile: "vendor-entry.mjs",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: out,
  legalComments: "inline",
  logLevel: "error",
  /* ⚠ The bundled tree is CommonJS underneath (postcss reaches for `path`),
     and an ESM bundle has no `require` for it to find — esbuild's stub throws
     "Dynamic require of ... is not supported" at load. This gives it a real
     one. It only ever resolves NODE BUILT-INS: every package in the graph was
     inlined at build time, which is the whole point of doing this. */
  banner: {
    js: [
      'import { createRequire as __vendorRequire } from "node:module";',
      "const require = __vendorRequire(import.meta.url);",
    ].join("\n"),
  },
});

/* The version the bundle was made from — what the smoke suite checks. */
const banner = `/* GENERATED — do not edit. \`npm run vendor:sanitizer\`.
   Bundled from sanitize-html@${version}; see scripts/vendor-sanitizer.mjs. */
export const SANITIZE_HTML_VERSION = ${JSON.stringify(version)};
`;
await writeFile(out, banner + (await readFile(out, "utf8")));

console.log(`[vendor] sanitize-html@${version} → ${path.relative(root, out)}`);
