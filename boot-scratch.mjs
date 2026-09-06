/* scratch only: dev-memory minus the (now broken) static-content seeder */
import { randomBytes } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
const mongod = await MongoMemoryServer.create();
process.env.NODE_ENV = "development";
process.env.MONGODB_URI = mongod.getUri("iwan_verify");
process.env.JWT_SECRET = "scratch-only";
process.env.CORS_ORIGINS = "";
process.env.PORT = "4000";
const { connectDb } = await import("/Users/aquibyazdani/Desktop/Iwan/iwan-cms-api/src/db.js");
const { createApp } = await import("/Users/aquibyazdani/Desktop/Iwan/iwan-cms-api/src/app.js");
const { User } = await import("/Users/aquibyazdani/Desktop/Iwan/iwan-cms-api/src/models/User.js");
const { Event } = await import("/Users/aquibyazdani/Desktop/Iwan/iwan-cms-api/src/models/Event.js");
await connectDb();
await User.create({ email: "dev@iwan.test", username: "dev", name: "Admin",
  passwordHash: await User.hashPassword("devpass1234"), role: "admin" });

const form = [{ key: "full_name", type: "name", label: "Your name", required: true, options: [] }];
const d = new Date(); d.setDate(d.getDate() + 20);
const soon = d.toISOString().slice(0, 10);
const d2 = new Date(); d2.setDate(d2.getDate() + 60);
await Event.create([
  { slug: "iwan-men-bbq", title: "Iwan Men BBQ", countries: [], status: "published",
    kind: "Study Circle", date: soon, start: "16:00", end: "19:00",
    venue: "Iwan Community Centre", summary: "BBQ and reflection.", details: "Details here.",
    agenda: [["04:00","Event starts"],["04:30","BBQ & food"],["12:30","Midday marker"],["19:05","Wrap up"]]
      .map(([time,label]) => ({ time, label })),
    form },
  { slug: "no-spots-event", title: "Asma Ul Husna Series", countries: [], status: "published",
    date: d2.toISOString().slice(0,10), start: "19:00", end: "20:30",
    venue: "Iwan Community", summary: "Series.", details: "Details.", form },
]);
createApp().listen(4000, () => console.log("READY http://localhost:4000  dev / devpass1234"));
