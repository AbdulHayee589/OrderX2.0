import { Agenda } from "agenda";
import { MongoBackend } from "@agendajs/mongo-backend";
import dotenv from "dotenv";

dotenv.config();

const mongoConnectionString = process.env.MONGO_URI;
if (!mongoConnectionString) {
  throw new Error("Missing MONGO_URI for Agenda backend");
}

export const agenda = new Agenda({
  backend: new MongoBackend({
    address: mongoConnectionString,
    collection: "agendaJobs",
  }),
  processEvery: "30 seconds",
  defaultConcurrency: 10,
  maxConcurrency: 20,
});

function summarizeAgendaError(err) {
  const message = String(err?.message || err || "");
  const cause = err?.cause || err?.reason?.servers?.values?.()?.next?.()?.value?.error;
  return {
    name: err?.name || "AgendaError",
    message,
    code: err?.code || cause?.code || null,
    hostname: cause?.hostname || cause?.cause?.hostname || null,
  };
}

// Important: attach this immediately so transient Mongo/Atlas failures
// never crash the whole API process due to an unhandled EventEmitter error.
agenda.on("error", (err) => {
  const summary = summarizeAgendaError(err);
  console.error("[AGENDA ERROR]", summary, err);
});
