import { buildApp } from "./app.js";
import { db } from "./db/client.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

const app = buildApp({ db });

app.listen({ port, host }).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
