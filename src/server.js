import { CONFIG, assertConfig } from "./config.js";
import { connectDb, disconnectDb } from "./db.js";
import { createApp } from "./app.js";

/* Boot order matters: configuration is checked before anything is opened, and
   the database is connected before the port is listening. A process that is
   accepting requests it cannot serve is worse than one that has not started —
   a health check would pass and the deploy would go green. */
async function main() {
  assertConfig();

  await connectDb();
  console.log(`[iwan-cms-api] connected to MongoDB (${CONFIG.env})`);

  const server = createApp().listen(CONFIG.port, () => {
    console.log(`[iwan-cms-api] listening on :${CONFIG.port}`);
  });

  /* Render sends SIGTERM and then waits before killing the process. Finishing
     the in-flight requests and closing the driver's sockets cleanly is what
     keeps a deploy from showing up as a handful of 502s. */
  const shutdown = async (signal) => {
    console.log(`[iwan-cms-api] ${signal} — shutting down`);
    server.close(async () => {
      await disconnectDb();
      process.exit(0);
    });
    /* If something is still holding a connection open after ten seconds, stop
       waiting for it. */
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[iwan-cms-api] failed to start:", err.message);
  process.exit(1);
});
