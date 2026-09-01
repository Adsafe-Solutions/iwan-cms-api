import "dotenv/config";

/* Everything read from the environment, validated at boot rather than at the
   first request that needs it — a missing MONGODB_URI should stop the process,
   not surface as a 500 an hour later. */

const list = (value = "") =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const CONFIG = {
  env: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  mongoUri: process.env.MONGODB_URI ?? "",
  jwtSecret: process.env.JWT_SECRET ?? "",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  corsOrigins: list(process.env.CORS_ORIGINS),

  /* ⚠ UNSET IS THE SWITCHED-OFF STATE — see lib/mail.js. A deployment without
     a key still takes sign-ups; it just sends nothing. */
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  /* ⚠ Resend requires this domain to be verified in its dashboard first. Until
     then only `onboarding@resend.dev` sends, and only to the account owner. */
  mailFrom: process.env.MAIL_FROM ?? "",
  mailReplyTo: process.env.MAIL_REPLY_TO ?? "",
  /* Builds the event link in the confirmation. Optional — the mail omits it. */
  siteUrl: process.env.SITE_URL ?? "",

  /* ⚠ Where IWAN is notified — the opposite direction to mailFrom. Every form
     on the site sends a heads-up here: registrations, messages, applications,
     subscriptions. Comma-separated for more than one; unset means no
     notifications at all, and every form still works. */
  mailTo: list(process.env.MAIL_TO),
  /* Deep-links the notification at the right CMS screen. Optional. */
  cmsUrl: (process.env.CMS_URL ?? "").replace(/\/$/, ""),

  /* How many public form submissions one address may make per ten minutes.
     ⚠ Shared across subscribe, contact, volunteer and career — the limit is on
     the person, not the form. Configurable so the smoke suite can raise it and
     still run the middleware, rather than skipping it and testing nothing. */
  formWriteLimit: Number(process.env.FORM_WRITE_LIMIT ?? 8),
  formAttemptLimit: Number(process.env.FORM_ATTEMPT_LIMIT ?? 40),

  /* Same idea for event registration, which carries its own tighter pair. */
  registerWriteLimit: Number(process.env.REGISTER_WRITE_LIMIT ?? 5),
  registerAttemptLimit: Number(process.env.REGISTER_ATTEMPT_LIMIT ?? 40),

  /* Cloudflare R2, where uploaded images are stored. ⚠ ALL FIVE or NONE —
     see assertConfig. With none set, uploading is switched off and the CMS
     falls back to pasting a URL, which is how it worked before. */
  r2: {
    accountId: process.env.R2_ACCOUNT_ID ?? "",
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
    bucket: process.env.R2_BUCKET ?? "",
    /* The CUSTOM DOMAIN in front of the bucket, not the S3 endpoint — this is
       what gets stored on the record and served to visitors. */
    publicUrl: (process.env.R2_PUBLIC_URL ?? "").replace(/\/$/, ""),
  },
};

/* Uploading needs every one of them; anything less is a misconfiguration
   rather than a feature switch. */
export const uploadsEnabled = () => Object.values(CONFIG.r2).every(Boolean);

export const isProduction = CONFIG.env === "production";

/* ⚠ A weak secret is fatal only in production: local work should not need one
   generated first, but a deployment on the .env.example placeholder would let
   anyone mint a valid admin token. */
const PLACEHOLDER_SECRET = "change-me-to-a-long-random-string";

export function assertConfig() {
  const problems = [];

  if (!CONFIG.mongoUri) problems.push("MONGODB_URI is not set");

  if (!CONFIG.jwtSecret) {
    if (isProduction) problems.push("JWT_SECRET is not set");
    else CONFIG.jwtSecret = "dev-only-insecure-secret";
  } else if (isProduction && CONFIG.jwtSecret === PLACEHOLDER_SECRET) {
    problems.push("JWT_SECRET is still the placeholder from .env.example");
  } else if (isProduction && CONFIG.jwtSecret.length < 32) {
    problems.push("JWT_SECRET is shorter than 32 characters");
  }

  if (isProduction && CONFIG.corsOrigins.length === 0) {
    problems.push("CORS_ORIGINS is empty — no browser origin could reach this API");
  }

  /* ⚠ Half-configured mail is refused everywhere: a key with no From address
     fails every send just after someone is told their place is booked. Neither
     being set is fine — that is mail switched off. */
  if (CONFIG.resendApiKey && !CONFIG.mailFrom) {
    problems.push("RESEND_API_KEY is set but MAIL_FROM is not — mail cannot send");
  }

  /* ⚠ Same trap in the other direction: an address to notify with no way to
     send would silently notify nobody. */
  if (CONFIG.mailTo.length && !CONFIG.resendApiKey) {
    problems.push("MAIL_TO is set but RESEND_API_KEY is not — nothing can be sent");
  }

  /* ⚠ Same all-or-nothing rule as mail. A half-set R2 block would let the CMS
     offer an Upload button that fails on every click. */
  const r2Set = Object.entries(CONFIG.r2).filter(([, v]) => v);
  if (r2Set.length && r2Set.length !== Object.keys(CONFIG.r2).length) {
    const missing = Object.entries(CONFIG.r2)
      .filter(([, v]) => !v)
      .map(([k]) => `R2_${k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`);
    problems.push(`R2 is half-configured — missing ${missing.join(", ")}`);
  }

  if (problems.length) {
    throw new Error(`Bad configuration:\n  - ${problems.join("\n  - ")}`);
  }
}

export default CONFIG;
