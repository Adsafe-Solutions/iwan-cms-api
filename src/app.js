import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import mongoose from "mongoose";
import { CONFIG, isProduction } from "./config.js";
import publicRoutes from "./routes/public.js";
import registerRoutes from "./routes/register.js";
import adminRoutes from "./routes/admin.js";
import authRoutes from "./routes/auth.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";

export function createApp() {
  const app = express();

  /* ⚠ Render (like every managed host) terminates TLS at a proxy and forwards
     the real client address in X-Forwarded-For. Without this, every request
     appears to come from the proxy — which would make the login rate limiter a
     single global bucket that one attacker could exhaust for everybody.
     `1` rather than `true`: trust exactly one hop, so a caller cannot forge the
     header and be believed. */
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  /* This API serves JSON to other origins and renders no HTML of its own, so
     the browser-facing parts of helmet's defaults have nothing to protect.
     CSP is off for that reason; the transport and sniffing headers stay on.
     crossOriginResourcePolicy is relaxed because the public site is a different
     origin and the default ("same-origin") would block it. */
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    })
  );

  app.use(
    cors({
      /* A request with NO Origin header — curl, a health check, anything
         server-to-server — is allowed: CORS exists to protect a browser user
         from their own credentials being replayed, and there is no browser
         here. Everything else has to be on the list.
         ⚠ In development the list is advisory: an empty CORS_ORIGINS locally
         means "allow anything", so a colleague on another port is not blocked.
         config.js refuses to boot with an empty list in production. */
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

  /* 1MB is generous for a blog post as structured blocks and small enough that
     a runaway paste cannot exhaust the dyno's memory. */
  app.use(express.json({ limit: "1mb" }));

  app.use(morgan(isProduction ? "combined" : "dev"));

  /* Render polls this to decide whether the service is up. It reports the
     database separately from the process: the API answering while Mongo is
     disconnected is exactly the state worth being able to see. */
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
  /* ⚠ The only route the public can WRITE to. Mounted before the read-only
     public router so its own rate limit applies to it and nothing else. */
  app.use("/api", registerRoutes);
  app.use("/api/admin", adminRoutes);
  /* Last of the three: its routes are the broadest, and mounting it first would
     shadow nothing today but would quietly swallow a future /api/admin-like
     path added under it. */
  app.use("/api", publicRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
