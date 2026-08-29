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

  /* How many public form submissions one address may make per ten minutes.
     ⚠ Shared across subscribe, contact, volunteer and career — the limit is on
     the person, not the form. Configurable so the smoke suite can raise it and
     still run the middleware, rather than skipping it and testing nothing. */
  formWriteLimit: Number(process.env.FORM_WRITE_LIMIT ?? 8),
  formAttemptLimit: Number(process.env.FORM_ATTEMPT_LIMIT ?? 40),
};

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

  if (problems.length) {
    throw new Error(`Bad configuration:\n  - ${problems.join("\n  - ")}`);
  }
}

export default CONFIG;
