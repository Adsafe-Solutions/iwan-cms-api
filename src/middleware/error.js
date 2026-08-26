import { ZodError } from "zod";
import { HttpError } from "../lib/errors.js";
import { isProduction } from "../config.js";

export const notFoundHandler = (req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
};

/* The single place a thrown error becomes a response: Mongoose and Zod shapes
   are translated so a caller only sees `{ error, details? }`.

   ⚠ Express identifies an error handler by its ARITY — all four arguments must
   stay even though `next` is unused, or this registers as ordinary middleware
   and every error becomes an unhandled 500. */
// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "Some fields are not valid",
      details: err.issues.map((i) => ({
        field: i.path.join(".") || "(body)",
        message: i.message,
      })),
    });
  }

  if (err?.name === "ValidationError" && err.errors) {
    return res.status(400).json({
      error: "Some fields are not valid",
      details: Object.entries(err.errors).map(([field, e]) => ({
        field,
        message: e.message,
      })),
    });
  }

  /* Always the unique slug in practice, so the message names the field. */
  if (err?.code === 11000) {
    const field = Object.keys(err.keyPattern ?? {})[0] ?? "value";
    return res.status(409).json({
      error: `That ${field} is already taken`,
      details: [{ field, message: "Must be unique" }],
    });
  }

  /* A malformed ObjectId — a 400, not the 500 a raw CastError becomes. */
  if (err?.name === "CastError") {
    return res.status(400).json({ error: `Not a valid ${err.path}` });
  }

  console.error("Unhandled error:", err);

  return res.status(500).json({
    error: "Something went wrong",
    /* Useful locally, an information leak in production. */
    ...(isProduction ? {} : { detail: err?.message, stack: err?.stack }),
  });
};
