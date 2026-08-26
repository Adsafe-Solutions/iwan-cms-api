/* Fills in `html` for posts written before the rich-text editor, from their
   `[kind, text]` blocks.

     npm run migrate:blog-html -- --dry
     npm run migrate:blog-html

   Safe to re-run: only posts whose `html` is still empty are touched, so a
   rewritten post is never overwritten by its own stale blocks. ⚠ The original
   `body` blocks are left in place so this can be redone if the mapping turns
   out to be wrong. */

import mongoose from "mongoose";
import { CONFIG, assertConfig } from "../src/config.js";
import { connectDb, disconnectDb } from "../src/db.js";
import { Blog } from "../src/models/Blog.js";
import { blocksToHtml, isEmptyHtml } from "../src/lib/html.js";

const dry = process.argv.includes("--dry");

async function main() {
  assertConfig();

  console.log(`[migrate] target: ${CONFIG.mongoUri.replace(/\/\/[^@]+@/, "//***@")}`);
  if (dry) console.log("[migrate] --dry: nothing will be written");

  await connectDb();

  const posts = await Blog.find().select("slug title html body").lean();

  let converted = 0;
  let skipped = 0;
  let empty = 0;

  for (const post of posts) {
    if (!isEmptyHtml(post.html ?? "")) {
      skipped += 1;
      continue;
    }

    const html = blocksToHtml(post.body ?? []);

    if (!html) {
      /* Neither HTML nor blocks. Not an error — just an empty post. */
      console.log(`  · ${post.slug}: nothing to convert`);
      empty += 1;
      continue;
    }

    const blocks = (post.body ?? []).length;
    console.log(`  ✓ ${post.slug}: ${blocks} blocks → ${html.length} chars of HTML`);

    if (!dry) {
      /* `$set` so the sanitising setter runs and `updatedAt` moves. */
      await Blog.updateOne({ _id: post._id }, { $set: { html } });
    }
    converted += 1;
  }

  console.log(
    `\n[migrate] ${converted} converted · ${skipped} already had HTML · ${empty} empty`
  );
  if (dry && converted) console.log("[migrate] re-run without --dry to apply");

  await disconnectDb();
}

main().catch(async (err) => {
  console.error(`[migrate] failed: ${err.message}`);
  if (mongoose.connection.readyState === 1) await disconnectDb();
  process.exit(1);
});
