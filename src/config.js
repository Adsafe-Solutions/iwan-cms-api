import "dotenv/config";

/* Everything this service reads from the environment, in one place, validated
   at boot rather than at the first request that happens to need it — a missing
   MONGODB_URI should stop the process, not surface as a 500 an hour later. */

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

  /* Transactional mail — see lib/mail.js.
     ⚠ UNSET IS THE SWITCHED-OFF STATE. Without a key nothing is sent and
     registration behaves exactly as it did before confirmations existed, so a
     deployment that has not been given one still takes sign-ups. */
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  /* The From address. Resend requires its domain to be verified in the Resend
     dashboard first — until then only `onboarding@resend.dev` will send, and
     only to the address that owns the Resend account. */
  mailFrom: process.env.MAIL_FROM ?? "",
  mailReplyTo: process.env.MAIL_REPLY_TO ?? "",
  /* Used to build the event link inside the confirmation. Optional: with no
     site URL the mail simply omits the link. */
  siteUrl: process.env.SITE_URL ?? "",
};

export const isProduction = CONFIG.env === "production";

/* ⚠ A weak or absent JWT secret is only fatal in production. Local work should
   not need a secret generated before the server will start, but a deployment
   running on the .env.example placeholder would let anyone mint a valid admin
   token, so that is refused outright. */
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

  /* ⚠ Half-configured mail is the one state worth refusing, in any environment:
     a key with no From address means every send fails at the point where
     someone has just been told their place is booked. Neither being set is
     fine — that is mail switched off. */
  if (CONFIG.resendApiKey && !CONFIG.mailFrom) {
    problems.push("RESEND_API_KEY is set but MAIL_FROM is not — mail cannot send");
  }

  if (problems.length) {
    throw new Error(`Bad configuration:\n  - ${problems.join("\n  - ")}`);
  }
}

export default CONFIG;
