import mongoose from "mongoose";
import { CONFIG } from "./config.js";

/* One connection for the life of the process. This is a long-lived service,
   not a serverless function, so there is nothing to cache around — connect once
   and let the driver's pool handle concurrency. */
export async function connectDb(uri = CONFIG.mongoUri) {
  mongoose.set("strictQuery", true);

  /* Fail fast rather than the driver's 30s default, so an unreachable Atlas
     turns the deploy red immediately instead of hanging. */
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });

  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}

export default connectDb;
