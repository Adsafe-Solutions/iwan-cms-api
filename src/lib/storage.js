import crypto from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { CONFIG, uploadsEnabled } from "../config.js";
import { badRequest } from "./errors.js";

/* Images to Cloudflare R2, served back through cdn.iwan.community.

   ⚠ The CMS stores a URL STRING, exactly as it did when editors pasted one in.
   Nothing downstream — no model, no serialiser, no page on the site — knows
   whether a URL was uploaded or typed. That is what keeps this additive: the
   hotlinked i0.wp.com images keep working untouched. */

/* ⚠ Vercel rejects a request body over 4.5MB BEFORE the function runs, with
   its own opaque error — multer's limit below would never see it and the CMS
   would show a platform page instead of a sentence. So the default is under
   that cap when running there, and stays 10MB on a normal server. */
const DEFAULT_MAX_MB = process.env.VERCEL ? 4 : 10;

export const MAX_UPLOAD_BYTES =
  Number(process.env.UPLOAD_MAX_MB || DEFAULT_MAX_MB) * 1024 * 1024;

/* What the browser is allowed to send. The stored file is always webp — see
   below — so this is only about what sharp can be trusted to decode. */
export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"];

/* ⚠ Wide enough for a full-bleed hero on a 2x display, and no wider. The site
   learned this the hard way: the live blog images are 8–9MB camera JPEGs, and
   pulling several at once has the CDN answering 429. Resizing on the way IN
   means nobody can ever put one in the CMS again. `withoutEnlargement` leaves
   a smaller image alone rather than blowing it up into mush. */
const MAX_EDGE = 1600;

let client = null;

/* Built once, lazily — the constructor reads config that assertConfig has
   validated by the time any request arrives. */
const s3 = () => {
  if (!client) {
    client = new S3Client({
      region: "auto",
      endpoint: `https://${CONFIG.r2.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: CONFIG.r2.accessKeyId,
        secretAccessKey: CONFIG.r2.secretAccessKey,
      },
    });
  }
  return client;
};

/* uploads/<year>/<month>/<random>.webp

   ⚠ Random, never the uploaded filename. Two editors uploading "photo.jpg"
   must not collide, an uploaded name can carry path separators or unicode that
   breaks a URL, and the `uploads/` prefix keeps this away from the files placed
   in the bucket by hand — which the site already hotlinks. */
const keyFor = () => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `uploads/${now.getFullYear()}/${month}/${crypto.randomUUID()}.webp`;
};

/* Takes the raw bytes, returns the public URL. Throws a 400 for anything that
   is not a decodable image — including a file that merely CLAIMS to be one. */
export async function storeImage(buffer, mimetype = "") {
  if (!uploadsEnabled()) {
    throw badRequest("Uploading is not configured on this server");
  }

  if (!ACCEPTED_TYPES.includes(mimetype)) {
    throw badRequest("That file type is not accepted", [
      { field: "file", message: "Upload a JPEG, PNG, WebP or AVIF image." },
    ]);
  }

  let resized;
  let width;
  let height;
  try {
    /* ⚠ The real check. A .jpg extension and an image/jpeg header are both
       just claims; sharp failing to decode is what proves it is not an image.
       `rotate()` first applies the EXIF orientation, which is dropped with the
       rest of the metadata — without it, phone photos come out sideways. */
    const image = sharp(buffer, { failOn: "error" }).rotate();
    const meta = await image.metadata();

    resized = await image
      .resize({
        width: MAX_EDGE,
        height: MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 82 })
      .toBuffer();

    width = Math.min(meta.width ?? MAX_EDGE, MAX_EDGE);
    height = meta.height ?? null;
  } catch {
    throw badRequest("That file could not be read as an image", [
      { field: "file", message: "It may be corrupt, or not an image at all." },
    ]);
  }

  const key = keyFor();

  await s3().send(
    new PutObjectCommand({
      Bucket: CONFIG.r2.bucket,
      Key: key,
      Body: resized,
      ContentType: "image/webp",
      /* A year, immutable — the key is random, so a given URL's bytes can
         never change. Re-uploading produces a new key instead. */
      CacheControl: "public, max-age=31536000, immutable",
    })
  );

  return {
    url: `${CONFIG.r2.publicUrl}/${key}`,
    key,
    bytes: resized.length,
    width,
    height,
  };
}

export default storeImage;
