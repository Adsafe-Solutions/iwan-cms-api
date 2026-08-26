import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import mongoose from "mongoose";
import { CONFIG, isProduction } from "./config.js";
import publicRoutes from "./routes/public.js";
import registerRoutes from "./routes/register.js";
import formRoutes from "./routes/forms.js";
import adminRoutes from "./routes/admin.js";
import authRoutes from "./routes/auth.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";

export function createApp() {
  const app = express();

  /* ⚠ Render terminates TLS at a proxy and forwards the client address in
     X-Forwarded-For. Without this every request looks like it came from the
     proxy, making the rate limiters one global bucket. `1` rather than `true`
     trusts exactly one hop, so a caller cannot forge the header. */
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  /* This API renders no HTML, so CSP has nothing to protect; the transport and
     sniffing headers stay on. crossOriginResourcePolicy is relaxed because the
     public site is a different origin and "same-origin" would block it. */
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    })
  );

  app.use(
    cors({
      /* No Origin header (curl, health checks, server-to-server) is allowed:
         CORS protects a browser user from replayed credentials, and there is no
         browser here. ⚠ In development an empty CORS_ORIGINS means "allow
         anything"; config.js refuses that in production. */
      origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (!isProduction && CONFIG.corsOrigins.length === 0) {
          return callback(null, true);
        }
        if (CONFIG.corsOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`Origin not allowed: ${origin}`));
      },
      credentials: false,
    })
  );

  /* Generous for a blog post, small enough that a runaway paste cannot
     exhaust the dyno's memory. */
  app.use(express.json({ limit: "1mb" }));

  app.use(morgan(isProduction ? "combined" : "dev"));

  /* Reports the database separately from the process — the API answering while
     Mongo is disconnected is the state worth being able to see. */
  app.get("/health", (_req, res) => {
    const states = ["disconnected", "connected", "connecting", "disconnecting"];
    const state = states[mongoose.connection.readyState] ?? "unknown";
    res.status(state === "connected" ? 200 : 503).json({
      ok: state === "connected",
      db: state,
      env: CONFIG.env,
      uptime: Math.round(process.uptime()),
    });
  });

  app.use("/api/auth", authRoutes);
  /* ⚠ The only route the public can WRITE to, mounted first so its own rate
     limit applies to it and nothing else. */
  app.use("/api", registerRoutes);
  /* The other public writes — subscribe, contact, volunteer, career. Mounted
     beside register for the same reason: their own rate limits apply here and
     nowhere else. */
  app.use("/api", formRoutes);
  app.use("/api/admin", adminRoutes);
  /* Last: its routes are the broadest and would swallow a future /api/admin-
     like path mounted after it. */
  app.use("/api", publicRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
