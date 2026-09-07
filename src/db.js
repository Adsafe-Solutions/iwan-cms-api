import mongoose from "mongoose";
import { CONFIG } from "./config.js";

/* One connection per process — a long-lived server opens it at boot, a
   serverless instance on its first request. Either way it is opened once and
   the driver's pool handles concurrency from there. */
export async function connectDb(uri = CONFIG.mongoUri, options = {}) {
  mongoose.set("strictQuery", true);

  /* Fail fast rather than the driver's 30s default, so an unreachable Atlas
     turns the deploy red immediately instead of hanging. */
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, ...options });

  return mongoose.connection;
}

/* ⚠ SERVERLESS ONLY. A function instance is frozen between requests and thawed
   for the next one, so the module scope survives — but many instances run at
   once, and each one opening a pool is how an Atlas connection limit gets
   eaten. This connects at most once per instance, keeps the PROMISE rather
   than the connection so two simultaneous cold requests share one attempt, and
   drops it on failure so the next request can try again instead of inheriting
   a rejected promise forever.

   `maxPoolSize: 1` for the same reason: an instance serves one request at a
   time, so a pool of five is four idle sockets against the cluster's cap. */
let opening = null;

export function connectDbOnce() {
  if (mongoose.connection.readyState === 1) return Promise.resolve(mongoose.connection);
  if (!opening) {
    opening = connectDb(CONFIG.mongoUri, { maxPoolSize: 1 }).catch((err) => {
      opening = null;
      throw err;
    });
  }
  return opening;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}

export default connectDb;
