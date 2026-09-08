/* The serverless entrypoint — Vercel invokes this, Render does not.

   ⚠ `src/server.js` is NOT usable here and never was: it exports nothing for a
   platform to call, it opens a port, and it ends in `process.exit(1)` on any
   configuration problem. On Vercel that is a crashed function on every request
   (FUNCTION_INVOCATION_FAILED), whatever the environment holds. The two
   entrypoints share `createApp()` and differ only in how they start.

   ⚠ NOTHING IS IMPORTED AT MODULE SCOPE except this file's own guards. A throw
   while a module loads — a native binary that will not load in a bundled
   function, a missing dependency, a bad env read — happens before any handler
   runs, so the platform reports a crash and nothing else: no message, no
   stack, the same opaque 500 on every route including ones that touch none of
   it. Importing inside the handler turns all of that into a 503 that says
   which module failed and why, in the response and in the log. */

let appPromise = null;

/* Loaded once per instance and remembered. A failure is NOT remembered: the
   next request retries, so a cold start that raced a slow dependency does not
   poison the instance for its whole life. */
async function loadApp() {
  if (!appPromise) {
    appPromise = (async () => {
      const { assertConfig } = await import("../src/config.js");
      const { connectDbOnce } = await import("../src/db.js");
      const { createApp } = await import("../src/app.js");
      const { ensureDefaultApplyForms } = await import("../src/lib/applyForms.js");

      assertConfig();
      await connectDbOnce();

      /* ⚠ Logged rather than thrown, exactly as the server does: a default
         form that could not be written is worth shouting about, not a reason
         to refuse every other route. */
      try {
        const created = await ensureDefaultApplyForms();
        if (created.length) {
          console.log(
            `[iwan-cms-api] created default application forms: ${created.join(", ")}`
          );
        }
      } catch (err) {
        console.error(
          "[iwan-cms-api] could not ensure the default application forms:",
          err.message
        );
      }

      return createApp();
    })().catch((err) => {
      appPromise = null;
      throw err;
    });
  }
  return appPromise;
}

export default async function handler(req, res) {
  let app;
  try {
    app = await loadApp();
  } catch (err) {
    /* The whole point of this file: say what happened. The log carries the
       stack, the response carries the sentence — which names a module or a
       variable, never a value. */
    console.error("[iwan-cms-api] failed to start:", err);
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    return res.end(
      JSON.stringify({
        error: "The API could not start",
        reason: String(err?.message ?? err).slice(0, 300),
        /* ⚠ Reported even when startup FAILED, which is the only moment it is
           hard to find out: `/health` cannot answer if the app never built.
           Two questions in one field — which Node is really running (the
           dashboard shows the version a build was made with, not always the
           one executing), and whether this deployment is the newest one at
           all: an older build has no `node` key here to print. */
        node: process.version,
      })
    );
  }

  return app(req, res);
}
