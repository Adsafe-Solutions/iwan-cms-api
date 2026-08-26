import { CONFIG, assertConfig } from "./config.js";
import { connectDb, disconnectDb } from "./db.js";
import { createApp } from "./app.js";

/* ⚠ Boot order matters: config is checked before anything opens, and the
   database is connected before the port listens. A process accepting requests
   it cannot serve passes its health check and turns the deploy green. */
async function main() {
  assertConfig();

  await connectDb();
  console.log(`[iwan-cms-api] connected to MongoDB (${CONFIG.env})`);

  const server = createApp().listen(CONFIG.port, () => {
    console.log(`[iwan-cms-api] listening on :${CONFIG.port}`);
  });

  /* Render sends SIGTERM then waits. Finishing in-flight requests and closing
     the driver's sockets is what keeps a deploy from emitting 502s. */
  const shutdown = async (signal) => {
    console.log(`[iwan-cms-api] ${signal} — shutting down`);
    server.close(async () => {
      await disconnectDb();
      process.exit(0);
    });
    /* Stop waiting on anything still holding a connection. */
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[iwan-cms-api] failed to start:", err.message);
  process.exit(1);
});
