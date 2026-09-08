/* The serverless entrypoint — Vercel invokes this, Render does not.

   ⚠ `src/server.js` is NOT usable here and never was: it exports nothing for a
   platform to call, it opens a port, and it ends in `process.exit(1)` on any
   configuration problem. On Vercel that is a crashed function on every request
   (FUNCTION_INVOCATION_FAILED), whatever the environment holds. The two
   entrypoints share `createApp()` and differ only in how they start.

   ⚠ Nothing here throws at module scope. A missing variable used to kill the
   process; here it would poison the whole instance, so it is caught and served
   as a 503 that says which one — the log names it, the response does not. */
import { CONFIG, assertConfig } from "../src/config.js";
import { connectDbOnce } from "../src/db.js";
import { createApp } from "../src/app.js";
import { ensureDefaultApplyForms } from "../src/lib/applyForms.js";

let configProblem = null;
try {
  assertConfig();
} catch (err) {
  configProblem = err;
  console.error("[iwan-cms-api] bad configuration:", err.message);
}

const app = createApp();

let seeded = false;
const ensureSeeded = async () => {
  if (seeded) return;
  seeded = true;
  try {
    const created = await ensureDefaultApplyForms();
    if (created.length) {
      console.log(
        `[iwan-cms-api] created default application forms: ${created.join(", ")}`
      );
    }
  } catch (err) {
    console.error("[iwan-cms-api] could not ensure the default application forms:", err);
  }
};

/* ⚠ In FRONT of the app, so no route can run against a closed connection. The
   long-lived server gets this for free by connecting before it listens. */
export default async function handler(req, res) {
  if (configProblem) {
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ error: "The API is not configured" }));
  }

  try {
    await connectDbOnce();
  } catch (err) {
    console.error(`[iwan-cms-api] database unreachable (${CONFIG.env}):`, err.message);
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ error: "The database is unreachable" }));
  }

  await ensureSeeded();
  return app(req, res);
}
