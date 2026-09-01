import { Router } from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { storeImage, MAX_UPLOAD_BYTES, ACCEPTED_TYPES } from "../lib/storage.js";
import { uploadsEnabled } from "../config.js";
import { badRequest, wrap } from "../lib/errors.js";

/* POST /api/admin/uploads — an image in, a CDN URL out.

   Mounted under the admin router, so requireAuth and requireWriter already
   apply: only a signed-in editor or admin can reach this, and a viewer's POST
   is refused by the method guard before it gets here. */

const router = Router();

/* ⚠ memoryStorage, deliberately: the file is resized and forwarded to R2
   within the request, so it never needs to touch this server's disk — which on
   Render is ephemeral anyway. The size cap is what keeps that safe. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    /* A first pass on the CLAIMED type, so an obvious non-image is refused
       before its bytes are buffered. storeImage re-checks by actually
       decoding it — this header can say anything. */
    cb(null, ACCEPTED_TYPES.includes(file.mimetype));
  },
});

/* Generous — an editor writing a photo essay uploads a dozen in a sitting —
   but bounded, because each one costs a resize and a PUT. */
const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "That is a lot of uploads at once. Try again in a moment." },
});

/* ⚠ Multer's own errors arrive as an error-first callback, not a rejected
   promise, so `wrap` cannot see them. Calling it by hand is what turns
   LIMIT_FILE_SIZE into a 400 the CMS can show instead of a 500. */
const single = (req, res, next) =>
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return next(
        badRequest("That image is too large", [
          {
            field: "file",
            message: `Images must be under ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB.`,
          },
        ])
      );
    }
    return next(badRequest(err.message || "That upload could not be read"));
  });

router.post(
  "/",
  uploadLimiter,
  single,
  wrap(async (req, res) => {
    /* ⚠ The request's own shape first: "you sent no file" is true whatever
       the server is configured to do with one, and reporting the config
       problem instead would send someone hunting the wrong thing. */
    if (!req.file) {
      throw badRequest("No image was uploaded", [
        { field: "file", message: "Choose a JPEG, PNG, WebP or AVIF image." },
      ]);
    }

    if (!uploadsEnabled()) {
      /* Configuration, not the caller's fault — but a 400 with a plain reason
         beats a 500, because the CMS shows this text to the person. */
      throw badRequest("Uploading is not configured on this server");
    }

    const stored = await storeImage(req.file.buffer, req.file.mimetype);
    res.status(201).json(stored);
  })
);

export default router;
