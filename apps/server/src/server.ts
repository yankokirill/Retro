import { buildApp } from "./app.js";
import { db } from "./db/client.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

const voterTokenSecret = process.env.VOTER_TOKEN_SECRET;
if (!voterTokenSecret) {
  throw new Error("VOTER_TOKEN_SECRET is not set — copy apps/server/.env.example to .env");
}

const app = buildApp({ db, voterTokenSecret });

app.listen({ port, host }).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
