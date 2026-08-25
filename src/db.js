import mongoose from "mongoose";
import { CONFIG } from "./config.js";

/* One connection for the life of the process. Render runs this as a normal
   long-lived Node service rather than a serverless function, so there is no
   cold-start-per-request problem to cache around — connect once at boot and
   let the driver's own pool handle concurrency. */
export async function connectDb(uri = CONFIG.mongoUri) {
  mongoose.set("strictQuery", true);

  /* Fail fast instead of the driver's 30s default: if Atlas is unreachable at
     boot we want the deploy to go red immediately, not hang. */
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });

  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}

export default connectDb;
