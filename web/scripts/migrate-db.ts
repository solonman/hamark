import { applySchema } from "../db/bootstrap.ts";

await applySchema();
console.log("Database schema is up to date.");
